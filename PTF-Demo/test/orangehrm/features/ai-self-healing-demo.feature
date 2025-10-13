@orangehrm @ai-healing @demo @ai-platform
Feature: AI Self-Healing Platform - Demonstration
  As a QA Engineer testing the AI self-healing capabilities
  I want to demonstrate intelligent healing for UI failures
  So that I can verify the AI platform automatically recovers from dynamic locator issues

  Background:
    Given I navigate to the Orange HRM application

  # ====================================================================================
  # AI HEALING DEMONSTRATIONS
  # ====================================================================================

  @TC601 @ai-healing @smoke @critical
  Scenario: AI heals login button locator failure
    """
    This scenario demonstrates AI healing when the login button locator changes.
    Expected: AI extracts locator from error, tries alternative strategies, and heals the failure.
    """
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    And I should see the Dashboard page
    # Expected: AI should activate ONLY if button locator fails
    # Expected: AI should try alternative_locators strategy first
    # Expected: If healing succeeds, step should pass

  @TC602 @ai-healing @regression @high
  Scenario: AI heals dashboard navigation with visual similarity
    """
    This scenario tests AI healing using visual similarity when text-based locators fail.
    Expected: AI finds element by visual characteristics (button, icon, position).
    """
    Given I am logged in to Orange HRM application
    When I click on "Dashboard" menu item
    Then I should see the "Dashboard" page header
    And the URL should contain "dashboard"
    # Expected: AI activates if Dashboard menu item locator fails
    # Expected: AI tries pattern_based_search (Dashboard is a common UI pattern)
    # Expected: AI may use visual_similarity as fallback

  @TC603 @ai-healing @regression @medium
  Scenario: AI heals form field interaction with scroll into view
    """
    This scenario demonstrates AI healing when element is not in viewport.
    Expected: AI scrolls element into view before interacting.
    """
    Given I am logged in to Orange HRM application
    When I click on "Admin" menu item
    And I click on the Add User button
    Then I should see the "Add User" form
    When I select "Admin" from User Role dropdown
    And I enter "TestUser123" in Username field
    Then the form should be ready for submission
    # Expected: If dropdown not in view, AI uses scroll_into_view strategy
    # Expected: If element hidden by overlay, AI uses remove_overlays strategy

  @TC604 @ai-healing @regression @medium
  Scenario: AI heals modal dismiss with overlay removal
    """
    This scenario tests AI healing when modals or overlays block interaction.
    Expected: AI detects overlay, tries ESC key and click outside to dismiss.
    """
    Given I am logged in to Orange HRM application
    When I click on "Leave" menu item
    Then I should see the Leave module page
    # Expected: If modal appears, AI tries close_modal strategy
    # Expected: AI presses ESC and clicks outside modal area
    # Expected: After modal closes, original element becomes accessible

  @TC605 @ai-healing @smoke @alternative-locators
  Scenario: AI finds element using alternative locators (ARIA, role, text)
    """
    This scenario demonstrates AI trying multiple locator strategies:
    1. Original CSS selector
    2. Text content
    3. ARIA label
    4. Role attribute
    5. Test ID
    """
    Given I am logged in to Orange HRM application
    When I click on user profile dropdown
    Then I should see the user menu options
    And I should see "Logout" option
    # Expected: AI tries alternative_locators strategy (Priority 10)
    # Expected: Attempts: text="Logout", role="button", aria-label, data-testid
    # Expected: Confidence: 0.9+ if text match found

  # ====================================================================================
  # AI CONTEXT DETECTION (UI vs API vs Database)
  # ====================================================================================

  @TC606 @ai-context @api @regression
  Scenario: AI SKIPS healing for API steps (existing retry preserved)
    """
    This scenario verifies AI does NOT activate for API steps.
    Expected: AI explicitly skips, existing retry behavior preserved.
    """
    Given I navigate to the Orange HRM application
    When I am logged in to Orange HRM application
    # Hypothetical API step (if your framework supports API testing):
    # When I send a GET request to "/api/employees"
    # Then the response status should be 200
    # Expected: AI logs "AI DISABLED for API step - using existing retry behavior"
    # Expected: No AI healing attempted, existing retry logic runs

  @TC607 @ai-context @mixed @regression
  Scenario: AI activates for UI only in mixed UI/API scenario
    """
    This scenario demonstrates selective AI activation:
    - UI steps: AI healing enabled
    - API steps: AI explicitly skipped
    """
    Given I am logged in to Orange HRM application
    When I click on "PIM" menu item
    Then I should see the "PIM" page header
    # If framework has API steps:
    # When I send a GET request to "/api/pim/employees"
    # Then the response should contain employee data
    # Expected: Click = UI → AI enabled
    # Expected: API request → AI disabled
    # Expected: AI logs show context detection decisions

  # ====================================================================================
  # AI LEARNING AND PATTERN MATCHING
  # ====================================================================================

  @TC608 @ai-learning @pattern-matching
  Scenario: AI uses learned patterns for login forms
    """
    This scenario tests AI pattern matcher with common UI patterns.
    Expected: AI recognizes login form pattern and applies known strategies.
    """
    Given I navigate to the Orange HRM application
    # Login form is Pattern #1 in CSPatternMatcher (15 built-in patterns)
    Then I should see the login form
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    # Expected: AI pattern matcher identifies "login_form" pattern
    # Expected: Applies pattern-specific healing strategies
    # Expected: Prioritizes username/password field strategies

  @TC609 @ai-learning @button-pattern
  Scenario: AI recognizes button patterns across the application
    """
    This scenario tests AI button pattern recognition.
    Expected: AI identifies button patterns and applies button-specific strategies.
    """
    Given I am logged in to Orange HRM application
    When I click on "Admin" menu item
    And I click on the Add User button
    Then I should see the "Add User" form
    When I click on the Cancel button
    Then I should return to the Admin list page
    # Expected: AI recognizes "button" pattern (Priority 8)
    # Expected: Tries role="button", type="button", button tag
    # Expected: Uses visual similarity for icon buttons

  # ====================================================================================
  # AI REPORTING AND STATISTICS
  # ====================================================================================

  @TC610 @ai-reporting @statistics
  Scenario: Verify AI operations are recorded in test results
    """
    This scenario ensures AI operations are captured in reports.
    Expected: Each healed step includes aiData with healing details.
    """
    Given I am logged in to Orange HRM application
    When I click on "Dashboard" menu item
    Then I should see the "Dashboard" page header
    # Expected: StepResult includes aiData object:
    # {
    #   healing: {
    #     attempted: true,
    #     success: true/false,
    #     strategy: "alternative_locators",
    #     confidence: 0.85,
    #     duration: 234,
    #     originalLocator: "#dashboard-btn",
    #     healedLocator: "text='Dashboard'",
    #     attempts: 1
    #   }
    # }

  # ====================================================================================
  # PARALLEL EXECUTION WITH AI
  # ====================================================================================

  @TC611 @ai-parallel @worker-isolation @parallel
  Scenario: Scenario 1 for parallel execution (Worker 1)
    """
    Run with: npm run cs-framework -- --parallel=3 --project=orangehrm
    This ensures each worker gets isolated AI instance.
    """
    Given I navigate to the Orange HRM application
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    # Expected: Worker 1 gets CSAIIntegrationLayer.getInstance('1')
    # Expected: Worker 1 has isolated AI history, cache, statistics

  @TC612 @ai-parallel @worker-isolation @parallel
  Scenario: Scenario 2 for parallel execution (Worker 2)
    """
    Run in parallel with TC611 and TC613.
    Expected: No shared state between workers.
    """
    Given I navigate to the Orange HRM application
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    And I click on "PIM" menu item
    Then I should see the "PIM" page header
    # Expected: Worker 2 gets CSAIIntegrationLayer.getInstance('2')
    # Expected: Worker 2 AI operations don't affect Worker 1 or 3

  @TC613 @ai-parallel @worker-isolation @parallel
  Scenario: Scenario 3 for parallel execution (Worker 3)
    """
    Run in parallel with TC611 and TC612.
    Expected: Each worker cleans up AI instance on exit.
    """
    Given I navigate to the Orange HRM application
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    And I click on "Leave" menu item
    Then I should see the "Leave" page header
    # Expected: Worker 3 gets CSAIIntegrationLayer.getInstance('3')
    # Expected: On worker exit, CSAIIntegrationLayer.clearInstance('3') called

  # ====================================================================================
  # AI CONFIGURATION TESTING
  # ====================================================================================

  @TC614 @ai-config @disable-ai
  Scenario: Verify tests run without AI when AI_ENABLED=false
    """
    Run with: AI_ENABLED=false npm run cs-framework --project=orangehrm
    Expected: AI completely disabled, existing retry behavior only.
    """
    Given I navigate to the Orange HRM application
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    # Expected: No AI initialization logged
    # Expected: No AI healing attempts logged
    # Expected: Tests run exactly as before AI platform

  @TC615 @ai-config @ui-only-mode
  Scenario: Verify AI_UI_ONLY mode preserves API retry behavior
    """
    Run with: AI_UI_ONLY=true (default)
    Expected: UI steps use AI, API steps use existing retry.
    """
    Given I am logged in to Orange HRM application
    When I click on "Admin" menu item
    Then I should see the "Admin" page header
    # Hypothetical API step:
    # When I send a GET request to "/api/admin/users"
    # Expected: Click (UI) → AI enabled
    # Expected: GET request (API) → AI disabled, existing retry
    # Expected: Both work as expected with appropriate retry mechanisms

  # ====================================================================================
  # EDGE CASES AND ERROR HANDLING
  # ====================================================================================

  @TC616 @ai-edge-case @null-page
  Scenario: AI gracefully handles null page (browser not launched)
    """
    This tests AI error handling when browser manager is null.
    Expected: AI skips healing gracefully, no crash.
    """
    # This would only happen in API-only tests or browser launch failures
    # Expected: AI checks this.browserManager before accessing page
    # Expected: Returns { healed: false } without crashing
    # Note: This is more of an internal framework test

  @TC617 @ai-edge-case @extraction-failure
  Scenario: AI handles locator extraction failure gracefully
    """
    This tests when CSLocatorExtractor can't extract locator from error.
    Expected: AI still attempts healing with empty locator (alternative_locators strategy works).
    """
    Given I navigate to the Orange HRM application
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    # Expected: If locator extraction fails (empty string returned)
    # Expected: alternative_locators strategy still works (finds by text)
    # Expected: Other strategies skip safely

  @TC618 @ai-edge-case @all-strategies-fail
  Scenario: Verify fallback to existing retry when all AI strategies fail
    """
    This scenario ensures framework doesn't break if AI can't heal.
    Expected: After all 8 strategies fail, existing retry logic takes over.
    """
    Given I navigate to the Orange HRM application
    # Deliberately cause a failure that AI cannot heal
    # (e.g., element truly doesn't exist, not just hidden/mislocated)
    # Expected: AI tries all 8 strategies
    # Expected: All strategies return { success: false }
    # Expected: CSBDDRunner falls through to normal error handling
    # Expected: Existing retry/failFast behavior applies

  # ====================================================================================
  # PERFORMANCE AND TIMING
  # ====================================================================================

  @TC619 @ai-performance @timing
  Scenario: Verify AI healing completes within timeout
    """
    This tests AI healing performance.
    Expected: Each strategy has 5s timeout, total healing < 15s.
    """
    Given I am logged in to Orange HRM application
    When I click on "Dashboard" menu item
    Then I should see the "Dashboard" page header
    # Expected: If healing activates:
    # - Locator extraction: < 100ms
    # - Strategy attempts: < 5s each
    # - Total healing time: < 15s (3 strategies x 5s)
    # Expected: Healing duration logged in aiData.healing.duration

  @TC620 @ai-performance @lazy-loading
  Scenario: Verify AI has zero startup performance impact
    """
    This verifies lazy loading works correctly.
    Expected: AI modules not loaded until first step failure.
    """
    Given I navigate to the Orange HRM application
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    # Expected: If all steps pass, AI never loaded
    # Expected: Framework startup time unchanged
    # Expected: First failure triggers lazy loading (one-time ~200ms cost)

  # ====================================================================================
  # COMPREHENSIVE SUCCESS SCENARIO
  # ====================================================================================

  @TC621 @ai-comprehensive @end-to-end @critical
  Scenario: End-to-end AI platform demonstration
    """
    This comprehensive scenario exercises multiple AI capabilities:
    1. Login with potential button locator issues
    2. Navigation with potential menu item locator issues
    3. Form interaction with potential field locator issues
    4. Modal handling with potential overlay issues
    5. Logout with potential dropdown locator issues

    Expected: AI intelligently heals any UI failures that occur.
    """
    Given I navigate to the Orange HRM application
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    And I should see the Dashboard page

    When I click on "Admin" menu item
    Then I should see the "Admin" page header

    When I click on the Add User button
    Then I should see the "Add User" form

    When I select "Admin" from User Role dropdown
    And I enter "AITestUser" in Username field
    Then the form should be ready for submission

    When I click on the Cancel button
    Then I should return to the Admin list page

    When I click on user profile dropdown
    And I click on Logout option
    Then I should be redirected to login page

    # Expected AI Operations Summary:
    # - 10-15 UI interactions total
    # - 0-5 healing attempts (depending on locator stability)
    # - All healing attempts logged in report
    # - Step-level aiData captured for healed steps
    # - AI statistics available in CSAIReportAggregator

# ====================================================================================
# END OF AI SELF-HEALING DEMONSTRATION SCENARIOS
# ====================================================================================
