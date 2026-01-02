@orangehrm @zero-code @demo @no-step-definitions
Feature: Zero-Code Test Execution - No Step Definitions Required
  As a QA Engineer
  I want to write feature files without writing step definitions
  So that I can create tests faster using natural language

  # ====================================================================================
  # ZERO-CODE FEATURE DEMONSTRATION
  # ====================================================================================
  # This feature file runs WITHOUT any step definitions!
  # The framework uses AI/NLP to understand and execute steps automatically.
  #
  # Configuration: INTELLIGENT_STEP_EXECUTION_ENABLED=true (default)
  # ====================================================================================

  @TC801 @zero-code @smoke
  Scenario: Zero-code login test (no step definitions needed)
    """
    This scenario demonstrates zero-code execution:
    - No step definitions written
    - Framework uses AI to understand "navigate", "type", "click", "see"
    - AI identifies elements intelligently
    - Steps execute automatically
    """
    Given I navigate to the Orange HRM application
    When I type "Admin" into the username field
    And I type "admin123" into the password field
    And I click the Login button
    Then I should see the Dashboard page

  @TC802 @zero-code @navigation
  Scenario: Zero-code navigation test
    """
    Demonstrates automatic navigation and assertion
    """
    Given I navigate to the Orange HRM application
    When I type "Admin" into the username field
    And I type "admin123" into the password field
    And I click the Login button
    Then I should see the main navigation menu
    When I click the Admin menu item
    Then the URL should contain "admin"

  @TC803 @zero-code @form-interaction
  Scenario: Zero-code form interaction
    """
    Demonstrates intelligent form field interaction
    """
    Given I navigate to the Orange HRM application
    When I type "Admin" into the username field
    And I type "admin123" into the password field
    And I click the Login button
    And I click the PIM menu item
    Then I should see the PIM page

  @TC804 @zero-code @assertions
  Scenario: Zero-code assertions
    """
    Demonstrates intelligent element visibility assertions
    """
    Given I navigate to the Orange HRM application
    Then I should see the login form
    And I should see the username field
    And I should see the password field
    And I should see the Login button

  # ====================================================================================
  # MIXED MODE: Zero-Code + Custom Step Definitions
  # ====================================================================================
  # Framework FIRST tries to find custom step definitions
  # If not found, THEN uses intelligent execution
  # This allows gradual migration from zero-code to custom steps
  # ====================================================================================

  @TC805 @zero-code @mixed-mode
  Scenario: Mixed mode - custom steps + zero-code
    """
    This scenario uses BOTH:
    - Custom step definitions (if available)
    - Zero-code intelligent execution (fallback)

    Framework behavior:
    1. Looks for custom step definition first
    2. If found → use custom implementation
    3. If not found → use intelligent execution
    4. This allows progressive enhancement!
    """
    Given I navigate to the Orange HRM application
    # This might have a custom step definition → uses it
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    # These likely use zero-code intelligent execution
    Then I should be logged in successfully
    And I should see the Dashboard page

  # ====================================================================================
  # ADVANCED ZERO-CODE PATTERNS
  # ====================================================================================

  @TC806 @zero-code @dropdown
  Scenario: Zero-code dropdown selection
    Given I navigate to the Orange HRM application
    When I type "Admin" into the username field
    And I type "admin123" into the password field
    And I click the Login button
    And I click the Admin menu item
    And I click the Add User button
    Then I should see the Add User form
    When I select "Admin" from the User Role dropdown
    Then I should see the form with Admin role selected

  @TC807 @zero-code @wait
  Scenario: Zero-code wait handling
    Given I navigate to the Orange HRM application
    When I type "Admin" into the username field
    And I wait for 1 second
    And I type "admin123" into the password field
    And I wait for 1 second
    And I click the Login button
    Then I should see the Dashboard page

  # ====================================================================================
  # ZERO-CODE WITH AI HEALING
  # ====================================================================================
  # When zero-code intelligent execution is combined with AI healing:
  # 1. Framework tries to find and execute step intelligently
  # 2. If element locator fails, AI healing kicks in
  # 3. Healing tries alternative strategies
  # 4. Step succeeds with healed locator
  #
  # Result: ULTRA-ROBUST zero-code tests!
  # ====================================================================================

  @TC808 @zero-code @ai-healing-combined
  Scenario: Zero-code + AI healing (ultimate robustness)
    """
    This scenario demonstrates the ULTIMATE combination:
    - No step definitions (zero-code)
    - AI understands steps intelligently
    - If element fails, AI healing activates
    - Healing finds alternative locators
    - Test passes even with dynamic elements!

    Expected benefits:
    - Write tests in pure natural language
    - No step definitions to maintain
    - No locator maintenance (AI handles it)
    - Ultra-robust against UI changes
    """
    Given I navigate to the Orange HRM application
    When I type "Admin" into the username field
    And I type "admin123" into the password field
    And I click the Login button
    # If Dashboard locator changes, AI healing finds it automatically!
    Then I should see the Dashboard page
    When I click the Leave menu item
    Then I should see the Leave page
    # Even if "Leave page" locator is fragile, AI heals it!

  # ====================================================================================
  # PERFORMANCE NOTES
  # ====================================================================================
  # Zero-code execution adds minimal overhead:
  # - Custom step definitions: 0ms overhead (direct execution)
  # - Intelligent execution: ~100-300ms overhead (NLP + element identification)
  # - AI healing (if needed): ~200-500ms overhead (healing strategies)
  #
  # For most UI tests, this overhead is negligible compared to page load times.
  # ====================================================================================

  # ====================================================================================
  # CONFIGURATION
  # ====================================================================================
  # To enable zero-code:
  #   INTELLIGENT_STEP_EXECUTION_ENABLED=true (default in config/global.env)
  #
  # To disable zero-code (require step definitions):
  #   INTELLIGENT_STEP_EXECUTION_ENABLED=false
  #
  # To enable AI healing with zero-code:
  #   AI_ENABLED=true (in config/common/ai.env)
  #   INTELLIGENT_STEP_EXECUTION_ENABLED=true
  # ====================================================================================
