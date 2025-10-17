/**
 * OrangeHRM Performance Testing - Configuration and Utilities
 *
 * This file provides OrangeHRM-specific performance testing configuration and utilities.
 * For BDD step definitions, see OrangeHRMPerformanceSteps.ts which implements them with proper class structure.
 */

// OrangeHRM Application Configuration for Performance Testing
export const ORANGEHRM_PERFORMANCE_CONFIG = {
    baseUrl: 'https://opensource-demo.orangehrmlive.com/',
    credentials: {
        username: 'Admin',
        password: 'admin123'
    },
    locators: {
        usernameField: '//input[@name="username"]',
        passwordField: '//input[@name="password"]',
        loginButton: '//button[@type="submit"]',
        logoutButton: '//span[text()="Logout"]'
    },
    performance: {
        thresholds: {
            loginTime: 5000,        // Maximum 5 seconds for login
            logoutTime: 3000,       // Maximum 3 seconds for logout
            pageLoadTime: 4000,     // Maximum 4 seconds for page load
            successRate: 95         // Minimum 95% success rate
        }
    }
};

// Test context interface for OrangeHRM testing
export interface OrangeHRMTestContext {
    performanceScenario?: any;
    testResult?: any;
    browser?: string;
    networkThrottling?: string;
    credentials?: { username: string; password: string };
    viewport?: { width: number; height: number };
    thresholds?: any;
    userCount?: number;
    testDuration?: number;
    thinkTime?: number;
}

/**
 * OrangeHRM Performance Testing Utilities
 */
export class OrangeHRMPerformanceUtils {
    /**
     * Create a Core Web Vitals test configuration for OrangeHRM
     */
    static createCoreWebVitalsConfig(customOptions?: any) {
        return {
            testType: 'core-web-vitals' as const,
            url: ORANGEHRM_PERFORMANCE_CONFIG.baseUrl,
            name: 'OrangeHRM Login Page Core Web Vitals',
            customThresholds: {
                // LCP (Largest Contentful Paint): Time until the largest visible element is rendered
                // Good: ≤2.5s, Needs Improvement: ≤4.0s, Poor: >4.0s
                // Measures when main content is visible to users
                lcp: 3000,              // 3 seconds threshold (acceptable range)

                // FID (First Input Delay): Time from first user interaction to browser response
                // Good: ≤100ms, Needs Improvement: ≤300ms, Poor: >300ms
                // Measures how quickly the page responds to user clicks/taps
                fid: 100,               // 100ms threshold (good performance)

                // CLS (Cumulative Layout Shift): Visual stability score (0-1 scale)
                // Good: ≤0.1, Needs Improvement: ≤0.25, Poor: >0.25
                // Measures how much content unexpectedly shifts during loading
                cls: 0.1,               // 0.1 threshold (good visual stability)

                // FCP (First Contentful Paint): Time until first content element appears
                // Good: ≤1.8s, Needs Improvement: ≤3.0s, Poor: >3.0s
                // Measures when users first see any content on the page
                fcp: 2000,              // 2 seconds threshold (good performance)

                // TTFB (Time To First Byte): Server response time from initial request
                // Good: ≤800ms, Needs Improvement: ≤1800ms, Poor: >1800ms
                // Measures server responsiveness and network latency
                ttfb: 1000              // 1 second threshold (acceptable server response)
            },
            ...customOptions
        };
    }

    /**
     * Create a page load test configuration for OrangeHRM
     */
    static createPageLoadConfig(customOptions?: any) {
        return {
            testType: 'page-load' as const,
            url: ORANGEHRM_PERFORMANCE_CONFIG.baseUrl,
            name: 'OrangeHRM Page Load Performance',
            thresholds: {
                responseTime: ORANGEHRM_PERFORMANCE_CONFIG.performance.thresholds.pageLoadTime,
                errorRate: 5
            },
            ...customOptions
        };
    }

    /**
     * Create a multi-user load test configuration for OrangeHRM
     */
    static createLoadTestConfig(userCount: number, customOptions?: any) {
        return {
            testType: 'ui-load' as const,
            url: ORANGEHRM_PERFORMANCE_CONFIG.baseUrl,
            concurrent: userCount,
            name: `OrangeHRM ${userCount}-User Load Test`,
            credentials: ORANGEHRM_PERFORMANCE_CONFIG.credentials,
            locators: ORANGEHRM_PERFORMANCE_CONFIG.locators,
            ...customOptions
        };
    }

    /**
     * Validate OrangeHRM performance results against thresholds
     */
    static validatePerformanceResults(result: any): { passed: boolean; violations: string[] } {
        const violations: string[] = [];

        // Check login time if available
        if (result.loginTime && result.loginTime > ORANGEHRM_PERFORMANCE_CONFIG.performance.thresholds.loginTime) {
            violations.push(`Login time ${result.loginTime}ms exceeds threshold ${ORANGEHRM_PERFORMANCE_CONFIG.performance.thresholds.loginTime}ms`);
        }

        // Check logout time if available
        if (result.logoutTime && result.logoutTime > ORANGEHRM_PERFORMANCE_CONFIG.performance.thresholds.logoutTime) {
            violations.push(`Logout time ${result.logoutTime}ms exceeds threshold ${ORANGEHRM_PERFORMANCE_CONFIG.performance.thresholds.logoutTime}ms`);
        }

        // Check page load time if available
        if (result.duration && result.duration > ORANGEHRM_PERFORMANCE_CONFIG.performance.thresholds.pageLoadTime) {
            violations.push(`Page load time ${result.duration}ms exceeds threshold ${ORANGEHRM_PERFORMANCE_CONFIG.performance.thresholds.pageLoadTime}ms`);
        }

        // Check success rate if available
        const successRate = result.successRate || (result.success ? 100 : 0);
        if (successRate < ORANGEHRM_PERFORMANCE_CONFIG.performance.thresholds.successRate) {
            violations.push(`Success rate ${successRate}% below threshold ${ORANGEHRM_PERFORMANCE_CONFIG.performance.thresholds.successRate}%`);
        }

        return {
            passed: violations.length === 0,
            violations
        };
    }

    /**
     * Helper method to get OrangeHRM configuration
     */
    static getOrangeHRMConfiguration() {
        return ORANGEHRM_PERFORMANCE_CONFIG;
    }

    /**
     * Validate OrangeHRM credentials
     */
    static validateOrangeHRMCredentials(credentials: any): boolean {
        return credentials && credentials.username && credentials.password;
    }

    /**
     * Create OrangeHRM performance scenario
     */
    static createOrangeHRMPerformanceScenario(type: string, config: any) {
        return {
            testType: type,
            url: ORANGEHRM_PERFORMANCE_CONFIG.baseUrl,
            name: `OrangeHRM ${type} Test`,
            ...config
        };
    }
}
