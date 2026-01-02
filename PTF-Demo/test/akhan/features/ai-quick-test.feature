@orangehrm @ai-quick-test @smoke
Feature: AI Platform Quick Test
  Quick verification of AI self-healing capabilities

  Background:
    Given I navigate to the Orange HRM application

  @TC701 @ai-enabled @quick
  Scenario: Basic login with AI enabled
    """
    Purpose: Verify AI platform is loaded and operational
    Expected: Login succeeds, AI logs show activation decisions
    """
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    And I should see the Dashboard page
    # Check logs for: [AIIntegration][main] Initialized
    # Check logs for: [AI] decision logs (enabled/disabled per step)

  @TC702 @ai-healing @quick
  Scenario: Dashboard navigation (AI may heal if locator changes)
    """
    Purpose: Test AI healing on common navigation scenario
    Expected: Navigation succeeds even if locators are fragile
    """
    Given I am logged in to Orange HRM application
    When I click on "Dashboard" menu item
    Then I should see the "Dashboard" page header
    When I click on "Admin" menu item
    Then I should see the "Admin" page header
    When I click on "PIM" menu item
    Then I should see the "PIM" page header
    # If any navigation fails, AI should attempt healing
    # Check logs for: [AI] Attempting intelligent healing
    # Check logs for: [AI] ✅ Healing successful! (if healing occurs)

  @TC703 @ai-parallel @quick
  Scenario: Scenario for parallel test 1
    """
    Run with: --parallel=2
    Purpose: Verify parallel execution with AI
    """
    Given I navigate to the Orange HRM application
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    Then I should be logged in successfully
    # Check logs for: [Worker 1] AI integration initialized

  @TC704 @ai-parallel @quick
  Scenario: Scenario for parallel test 2
    """
    Run with: --parallel=2
    Purpose: Verify worker isolation
    """
    Given I navigate to the Orange HRM application
    When I enter username "Admin" and password "admin123"
    And I click on the Login button
    And I click on "Leave" menu item
    Then I should see the "Leave" page header
    # Check logs for: [Worker 2] AI integration initialized
    # Verify no interference between workers
