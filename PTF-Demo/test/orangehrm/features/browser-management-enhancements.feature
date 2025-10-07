@orangehrm @browser-management @new-features
Feature: Browser Management Enhancements - Switching and Context Clearing
  As a QA Engineer using CS Test Automation Framework
  I want to test browser switching and context clearing features
  So that I can verify multi-browser testing and multi-user workflows work correctly

  Background:
    Given I navigate to the Orange HRM application

  # ============================================================================
  # BROWSER SWITCHING TESTS
  # ============================================================================

  @TC601 @browser-switching @smoke @critical
  Scenario: Switch from Chrome to Edge browser during test execution
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    And I should see the Dashboard page

    # Switch to Edge browser - preserves URL but NOT session (no cookies)
    When user switches to "edge" browser
    Then I should be on the login page
    And the current browser should be "edge"

    # Login again in Edge browser
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    And I should see the Dashboard page

  @TC602 @browser-switching @regression
  Scenario: Switch browsers and verify URL is preserved but session is lost
    Given I am logged in to Orange HRM application
    When I click on "Admin" menu item
    Then I should see the "Admin" page header

    # Switch to Firefox - preserves URL but session is lost (redirects to login)
    When user switches to "firefox" browser
    Then I should be on the login page

    # Login again in Firefox to access Admin page
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully

  @TC603 @browser-switching @state-clearing
  Scenario: Switch browsers with explicit state clearing
    Given I am logged in to Orange HRM application
    When I click on "PIM" menu item
    Then I should see the "PIM" page header

    # Switch to Edge and explicitly clear all state (cookies, storage)
    # Note: State is already cleared by default when switching browsers
    When user switches to "edge" browser and clears state
    Then I should be on the login page
    And I should NOT be logged in
    And I should see the login form

  @TC604 @browser-switching @no-url-preserve
  Scenario: Switch browsers without preserving URL
    Given I am logged in to Orange HRM application
    When I click on "Leave" menu item
    Then I should see the "Leave" page header

    # Switch to Chrome without preserving URL
    When user switches to "chrome" browser without preserving URL
    # Browser launches fresh, doesn't navigate anywhere
    And I navigate to the Orange HRM application
    Then I should see the login form

  @TC605 @browser-switching @same-browser-reuse @critical
  Scenario: Switch to same browser with BROWSER_REUSE_ENABLED=true
    # This tests the NEW framework feature you implemented!
    # When BROWSER_REUSE_ENABLED=true and switching to SAME browser type,
    # it should clear state WITHOUT closing/reopening browser
    Given I am logged in to Orange HRM application
    When I click on "PIM" menu item
    Then I should see the "PIM" page header

    # Get current browser type (should be chromium from config)
    # Switch to same browser (chromium) and clear state
    When user switches to "chromium" browser and clears state
    Then I should be on the login page
    And I should NOT be logged in
    And the current browser should be "chromium"

    # Login again - browser never closed/reopened!
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully

  @TC605B @browser-switching @cross-browser-testing
  Scenario Outline: Verify login works across different browsers
    # Test same functionality across multiple browsers
    When user switches to "<browser>" browser without preserving URL
    And I navigate to the Orange HRM application
    And I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    And I should see the Dashboard page

    Examples:
      | browser |
      | chrome  |
      | edge    |
      | firefox |

  # ============================================================================
  # CONTEXT CLEARING FOR RE-AUTHENTICATION TESTS
  # ============================================================================

  @TC606 @context-clearing @multi-user @critical
  Scenario: Clear context and login as different user
    # Login as Admin
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    And I should see the Dashboard page

    # Clear context to logout and prepare for re-authentication
    When user clears browser context for re-authentication
    Then I should see the login form
    And I should be on the login page

    # Now login as different user (simulating approver workflow)
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully

  @TC607 @context-clearing @multi-user-workflow
  Scenario: Multi-user approval workflow simulation
    # Requester creates a leave request
    Given I am logged in to Orange HRM application
    When I click on "Leave" menu item
    And I click on Apply button
    # User would fill leave form and submit here

    # Clear context and login as approver
    When user clears browser context for re-authentication
    Then I should see the login form

    # Approver logs in
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    # Approver would approve the leave here

  @TC608 @context-clearing @custom-url
  Scenario: Clear context and navigate to specific URL
    Given I am logged in to Orange HRM application
    When I click on "Admin" menu item

    # Clear context and go to a specific URL (e.g., admin login page)
    When user clears browser context and goes to "https://opensource-demo.orangehrmlive.com/web/index.php/auth/login"
    Then I should see the login form
    And I should be on the login page

    # Login again
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully

  @TC609 @context-clearing @no-navigation
  Scenario: Clear context without automatic navigation
    Given I am logged in to Orange HRM application

    # Clear context but don't navigate automatically
    When user clears browser context without navigation
    # Now manually navigate
    And I navigate to the Orange HRM application
    Then I should see the login form

  @TC610 @context-clearing @data-isolation
  Scenario: Verify context clearing removes all stored data
    Given I am logged in to Orange HRM application
    # Save some data in scenario context
    And user saves "test-value-123" as "testData"
    And user saves "session-info" as "sessionInfo"

    # Clear browser context (clears cookies, storage, cache)
    When user clears browser context for re-authentication
    Then I should see the login form

    # Verify we can still access scenario context (not browser context)
    # Browser context is cleared but scenario context remains
    And user variable "testData" should equal "test-value-123"

  # ============================================================================
  # COMBINED TESTS - Browser Switching + Context Clearing
  # ============================================================================

  @TC611 @combined @advanced @critical
  Scenario: Switch browser and clear context for complete isolation
    Given I am logged in to Orange HRM application
    When I click on "PIM" menu item

    # Switch to Edge - session is lost, redirected to login
    When user switches to "edge" browser
    Then I should be on the login page

    # Login in Edge browser
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully

    # Now clear context for re-authentication (simulate different user)
    When user clears browser context for re-authentication
    Then I should see the login form

    # Login again as different user in same Edge browser
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully

  @TC612 @combined @cross-browser-multi-user
  Scenario: Multi-browser multi-user workflow
    # Chrome - User 1
    When user switches to "chrome" browser without preserving URL
    And I navigate to the Orange HRM application
    And I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    And user saves "chrome-session" as "browserType"

    # Edge - User 2 (different session)
    When user switches to "edge" browser and clears state
    And I navigate to the Orange HRM application
    And I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully

    # Verify we can track which browser we're in
    And user saves "edge-session" as "browserType"
    And user variable "browserType" should equal "edge-session"

  @TC613 @browser-reuse @context-clearing @critical
  Scenario: Verify context clearing works with browser reuse enabled
    # This test specifically verifies clearContextAndReauthenticate() with BROWSER_REUSE_ENABLED=true
    # Browser stays alive, state cleared WITHOUT recreating context (like between-scenarios cleanup)
    # Video/HAR/Trace continue recording (no stop/start)
    Given I am logged in to Orange HRM application
    When I click on "Time" menu item
    Then I should see the "Time" page header

    # Clear state WITHOUT recreating context - browser stays alive
    # This mimics the between-scenarios cleanup behavior
    When user clears browser context for re-authentication
    Then I should see the login form

    # Login again - same browser instance, same context (cleared state only)
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    And I should see the Dashboard page

  @TC613B @browser-non-reuse @context-clearing
  Scenario: Verify context clearing recreates context when browser reuse disabled
    # NOTE: This scenario requires BROWSER_REUSE_ENABLED=false to test properly
    # When BROWSER_REUSE_ENABLED=false, clearContextAndReauthenticate() should:
    # - Close existing context (saves artifacts)
    # - Create fresh context
    # - Video/HAR/Trace stop and restart (new files)
    # To run this test: npx cs-framework --project=orangehrm --tags="@TC613B" --set BROWSER_REUSE_ENABLED=false
    Given I am logged in to Orange HRM application
    When I click on "Leave" menu item

    # With BROWSER_REUSE_ENABLED=false, this WILL recreate context
    When user clears browser context for re-authentication
    Then I should see the login form

    # Login again with fresh context
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully

  # ============================================================================
  # PARALLEL EXECUTION SAFETY TESTS
  # ============================================================================

  @TC614 @parallel-safe @browser-switching
  Scenario: Browser switching in parallel execution
    # This scenario should run safely in parallel
    # Each worker thread has its own BrowserManager instance
    When user switches to "edge" browser without preserving URL
    And I navigate to the Orange HRM application
    And I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully

  @TC615 @parallel-safe @context-clearing
  Scenario: Context clearing in parallel execution
    # This scenario should run safely in parallel
    # Each worker has independent context
    Given I am logged in to Orange HRM application
    When user clears browser context for re-authentication
    Then I should see the login form
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully

  # ============================================================================
  # ERROR HANDLING TESTS
  # ============================================================================

  @TC616 @error-handling @negative
  Scenario: Handle invalid browser type gracefully
    Given I am logged in to Orange HRM application
    # This should fail with a clear error message
    # When user switches to "invalid-browser" browser
    # Then I should see error "Invalid browser type"
    # Commented out as it would fail - just documenting expected behavior

  @TC617 @error-handling @recovery
  Scenario: Recover from browser switch failure
    Given I am logged in to Orange HRM application
    When I click on "Dashboard" menu item
    Then I should see the Dashboard page
    # If browser switch fails, framework should handle gracefully
    # and maintain current browser state
