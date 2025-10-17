# OrangeHRM Application Performance Testing - BDD Feature File
# Comprehensive Gherkin scenarios for OrangeHRM login performance testing

Feature: OrangeHRM Application Performance Testing
  As a performance engineer
  I want to test the OrangeHRM application performance
  So that I can ensure optimal user experience for login workflows

  Background:
    Given the OrangeHRM application is available at "https://opensource-demo.orangehrmlive.com/"
    And I have valid OrangeHRM credentials "Admin" and "admin123"

  @orangehrm-performance @core-web-vitals @single-user
  Scenario: OrangeHRM Login Page Core Web Vitals Assessment
    Given I have a Core Web Vitals test for the OrangeHRM login page
    And I set the browser to "chromium"
    And I configure the viewport to 1920x1080
    And I set network throttling to "fast-3g"
    When I execute the performance test
    Then the Largest Contentful Paint should be less than 3000 milliseconds
    And the First Input Delay should be less than 100 milliseconds
    And the Cumulative Layout Shift should be less than 0.1
    And the First Contentful Paint should be less than 2000 milliseconds
    And the Time to First Byte should be less than 1000 milliseconds
    And the Core Web Vitals score should be "good"

  @orangehrm-performance @page-load @single-user
  Scenario: OrangeHRM Application Page Load Performance
    Given I have a page load performance test for the OrangeHRM application
    And I set the browser to "chromium"
    And I set network throttling to "fast-3g"
    And I set the response time threshold to 4000 milliseconds
    When I execute the performance test
    Then the page load should complete in less than 4 seconds
    And the response time should be acceptable
    And there should be no critical errors

  @orangehrm-performance @authentication @single-user
  Scenario: Single User Login Performance
    Given I have a performance test for OrangeHRM user authentication
    And I use the credentials "Admin" and "admin123"
    And I set the browser to "chromium"
    When I perform a login operation
    Then the login should complete in less than 5000 milliseconds
    And the authentication should be successful
    When I perform a logout operation
    Then the logout should complete in less than 3000 milliseconds
    And I should be redirected to the login page

  @orangehrm-performance @load-test @multi-user
  Scenario: Multiple User Login Performance Test
    Given I have a UI load test with 5 concurrent users for OrangeHRM
    And I set the test duration to 60 seconds
    And I use the OrangeHRM credentials for all users
    And I set the think time to 2000 milliseconds
    When I execute the load test
    Then the success rate should be at least 95 percent
    And the average login time should be less than 6000 milliseconds
    And the average logout time should be less than 3000 milliseconds
    And there should be no system errors

  @orangehrm-performance @mobile @authentication
  Scenario: OrangeHRM Mobile Login Performance
    Given I have a Core Web Vitals test for the OrangeHRM login page
    And I set the browser to "chromium"
    And I enable mobile emulation for "iPhone 12"
    And I set network throttling to "slow-3g"
    When I execute the mobile performance test
    Then the Largest Contentful Paint should be less than 4000 milliseconds
    And the First Input Delay should be less than 150 milliseconds
    And the Cumulative Layout Shift should be less than 0.15
    And the mobile performance should be acceptable

  @orangehrm-performance @stress-test @multi-user
  Scenario: OrangeHRM Stress Test with High Concurrent Load
    Given I have a UI load test with 5 concurrent users for OrangeHRM
    And I set the test duration to 120 seconds
    And I use the OrangeHRM credentials for all users
    And I set the think time to 1000 milliseconds
    And I set network throttling to "slow-3g"
    When I execute the stress test
    Then the system should remain stable
    And the success rate should be at least 90 percent
    And there should be no performance degradation alerts

  @orangehrm-performance @cross-browser @compatibility
  Scenario Outline: Cross-Browser OrangeHRM Performance Testing
    Given I have a page load performance test for the OrangeHRM application
    And I set the browser to "<browser>"
    And I set the response time threshold to 4000 milliseconds
    When I execute the cross-browser performance test
    Then the page load should complete within the threshold
    And the browser compatibility should be verified

    Examples:
      | browser  |
      | chromium |
      | firefox  |
      | webkit   |

  @orangehrm-performance @progressive-load @scalability
  Scenario: Progressive Load Testing for OrangeHRM
    Given I want to test OrangeHRM scalability with increasing user load
    When I run performance tests with the following user counts:
      | users | duration |
      | 1     | 30       |
      | 2     | 30       |
      | 3     | 30       |
      | 5     | 30       |
    Then I should see performance metrics for each user count
    And I should identify the optimal user capacity
    And performance should degrade gracefully under load

  @orangehrm-performance @authentication-workflow @complete-journey
  Scenario: Complete OrangeHRM Authentication Workflow Performance
    Given I have a performance test for the complete OrangeHRM user journey
    And I use the credentials "Admin" and "admin123"
    And I set the browser to "chromium"
    When I start the performance monitoring
    And I navigate to the OrangeHRM login page
    And I fill in the username field with "Admin"
    And I fill in the password field with "admin123"
    And I click the login button
    And I wait for the dashboard to load
    And I verify successful authentication
    And I perform logout
    Then I stop the performance monitoring
    And the complete workflow should be within performance thresholds
    And each step should meet individual performance criteria

  @orangehrm-performance @network-conditions @real-world
  Scenario Outline: OrangeHRM Performance Under Various Network Conditions
    Given I have a Core Web Vitals test for the OrangeHRM login page
    And I set the browser to "chromium"
    And I set network throttling to "<network_condition>"
    When I execute the performance test under "<network_condition>" conditions
    Then the performance should be acceptable for "<network_condition>"
    And the Core Web Vitals should meet "<network_condition>" thresholds

    Examples:
      | network_condition |
      | fast-3g           |
      | slow-3g           |
      | 4g                |

  @orangehrm-performance @performance-budget @monitoring
  Scenario: OrangeHRM Performance Budget Validation
    Given I have defined performance budgets for OrangeHRM
    And the login time budget is 5000 milliseconds
    And the logout time budget is 3000 milliseconds
    And the page load budget is 4000 milliseconds
    And the Core Web Vitals budget follows Google standards
    When I execute comprehensive performance testing
    Then all performance metrics should be within budget
    And any budget violations should be reported
    And performance trends should be monitored

  @orangehrm-performance @security @authentication-timing
  Scenario: OrangeHRM Authentication Security Performance
    Given I have a performance test for OrangeHRM authentication security
    And I use valid credentials "Admin" and "admin123"
    When I measure authentication timing
    Then the authentication should not reveal timing information
    And failed login attempts should not impact performance
    And the system should remain secure under load

  @orangehrm-performance @accessibility @inclusive-performance
  Scenario: OrangeHRM Accessibility Performance Testing
    Given I have a Core Web Vitals test for the OrangeHRM application
    And I enable accessibility performance monitoring
    And I set the browser to "chromium"
    When I execute accessibility-focused performance testing
    Then the First Input Delay should support assistive technologies
    And the Cumulative Layout Shift should not affect screen readers
    And the application should be both fast and accessible

  @orangehrm-performance @real-time @monitoring
  Scenario: OrangeHRM Real-time Performance Monitoring
    Given I have configured real-time performance monitoring for OrangeHRM
    And I set performance alert thresholds
    When I start continuous performance monitoring
    And I perform various user operations
    Then I should receive real-time performance metrics
    And alerts should be triggered for threshold violations
    And performance data should be collected continuously

  @orangehrm-performance @baseline @comparison
  Scenario: OrangeHRM Performance Baseline Establishment
    Given I want to establish performance baselines for OrangeHRM
    When I execute a comprehensive performance test suite
    And I record baseline metrics for:
      | metric          | baseline_value |
      | login_time      | 3000           |
      | logout_time     | 2000           |
      | page_load_time  | 3500           |
      | lcp             | 2500           |
      | fid             | 100            |
      | cls             | 0.1            |
    Then I should have reliable performance baselines
    And future tests should compare against these baselines
    And performance regression should be detectable

  @orangehrm-performance @error-handling @resilience
  Scenario: OrangeHRM Performance Under Error Conditions
    Given I have a performance test for OrangeHRM error handling
    When I simulate various error conditions:
      | error_type            | expected_behavior       |
      | network_timeout       | graceful_degradation    |
      | server_error          | appropriate_error_message|
      | invalid_credentials   | secure_error_handling   |
    Then the system should maintain performance under errors
    And error responses should be timely
    And the system should recover gracefully

  @orangehrm-performance @data-driven @parameterized
  Scenario Outline: OrangeHRM Performance with Different User Loads
    Given I have a UI load test for OrangeHRM with "<user_count>" concurrent users
    And I set the test duration to "<duration>" seconds
    And I use different user credentials for load distribution
    When I execute the parameterized load test
    Then the success rate should be at least "<expected_success_rate>" percent
    And the average response time should be less than "<max_response_time>" milliseconds
    And system resources should be within acceptable limits

    Examples:
      | user_count | duration | expected_success_rate | max_response_time |
      | 1          | 30       | 100                   | 3000              |
      | 3          | 60       | 98                    | 4000              |
      | 5          | 90       | 95                    | 5000              |
      | 8          | 120      | 90                    | 6000              |
