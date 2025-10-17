import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSReporter } from '../../reporter/CSReporter';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { CSPerformanceTestRunner } from '../../performance/CSPerformanceTestRunner';
import {
    CSLoadTestScenario,
    CSStressTestScenario,
    CSSpikeTestScenario,
    CSEnduranceTestScenario,
    CSBaselineTestScenario,
    CSCoreWebVitalsScenario,
    CSPageLoadPerformanceScenario,
    CSUILoadTestScenario,
    CSVisualRegressionPerformanceScenario
} from '../../performance/scenarios/CSPerformanceScenario';
import { PerformanceTestResult, PerformanceScenarioConfig } from '../../performance/types/CSPerformanceTypes';

/**
 * Performance Testing BDD Steps
 * Provides Gherkin step definitions for performance testing scenarios
 */
export class CSPerformanceSteps {
    private static performanceRunner: CSPerformanceTestRunner = CSPerformanceTestRunner.getInstance();
    private static config: CSConfigurationManager = CSConfigurationManager.getInstance();
    private static currentScenario: any = null;
    private static testResults: Map<string, PerformanceTestResult> = new Map();

    // ===============================================================================
    // GIVEN STEPS - Test Setup and Configuration
    // ===============================================================================

    @CSBDDStepDef('I have a load test with {int} virtual users for {int} seconds')
    static setupLoadTest(users: number, duration: number): void {
        CSReporter.info(`Setting up load test: ${users} users for ${duration} seconds`);

        this.currentScenario = CSLoadTestScenario.createStandardLoadTest({
            name: `Load Test - ${users} users`,
            virtualUsers: users,
            duration: duration,
            targetUrl: this.config.get('PERFORMANCE_TARGET_URL', 'url')
        });
    }

    @CSBDDStepDef('I have a stress test from {int} to {int} users in {int} second steps')
    static setupStressTest(startUsers: number, maxUsers: number, stepDuration: number): void {
        CSReporter.info(`Setting up stress test: ${startUsers} to ${maxUsers} users, ${stepDuration}s steps`);

        this.currentScenario = CSStressTestScenario.createStandardStressTest({
            name: `Stress Test - ${startUsers} to ${maxUsers} users`,
            startUsers: startUsers,
            maxUsers: maxUsers,
            stepDuration: stepDuration,
            targetUrl: this.config.get('PERFORMANCE_TARGET_URL', 'url')
        });
    }

    @CSBDDStepDef('I have a spike test with {int} baseline users spiking to {int} users for {int} seconds')
    static setupSpikeTest(baselineUsers: number, spikeUsers: number, spikeDuration: number): void {
        CSReporter.info(`Setting up spike test: ${baselineUsers} baseline = ${spikeUsers} spike for ${spikeDuration}s`);

        this.currentScenario = CSSpikeTestScenario.createStandardSpikeTest({
            name: `Spike Test - ${baselineUsers} to ${spikeUsers} users`,
            baselineUsers: baselineUsers,
            spikeUsers: spikeUsers,
            spikeDuration: spikeDuration,
            totalDuration: spikeDuration + 120, // Include baseline periods
            targetUrl: this.config.get('PERFORMANCE_TARGET_URL', 'url')
        });
    }

    @CSBDDStepDef('I have an endurance test with {int} users for {int} hours')
    static setupEnduranceTest(users: number, hours: number): void {
        CSReporter.info(`Setting up endurance test: ${users} users for ${hours} hours`);

        this.currentScenario = CSEnduranceTestScenario.createStandardEnduranceTest({
            name: `Endurance Test - ${users} users for ${hours}h`,
            virtualUsers: users,
            durationHours: hours,
            targetUrl: this.config.get('PERFORMANCE_TARGET_URL', 'url')
        });
    }

    @CSBDDStepDef('I have a baseline performance test with {int} user(s)')
    static setupBaselineTest(users: number): void {
        CSReporter.info(`Setting up baseline test: ${users} user(s)`);

        this.currentScenario = CSBaselineTestScenario.createBaselineTest({
            name: `Baseline Test - ${users} user(s)`,
            virtualUsers: users,
            duration: 300, // 5 minutes
            targetUrl: this.config.get('PERFORMANCE_TARGET_URL', 'url')
        });
    }

    @CSBDDStepDef('I set the target URL to {string}')
    static setTargetUrl(url: string): void {
        if (this.currentScenario) {
            const config = this.currentScenario.getConfiguration();
            config.targetEndpoint = url;
            this.currentScenario.updateConfiguration(config);
            CSReporter.info(`Target URL set to: ${url}`);
        } else {
            throw new Error('No performance scenario configured. Use a setup step first.');
        }
    }

    @CSBDDStepDef('I set the request method to {string}')
    static setRequestMethod(method: string): void {
        if (this.currentScenario) {
            const config = this.currentScenario.getConfiguration();
            if (!config.requestTemplate) {
                config.requestTemplate = {
                    method: 'GET' as any,
                    url: config.targetEndpoint || 'url_end'
                };
            }
            config.requestTemplate.method = method.toUpperCase() as any;
            this.currentScenario.updateConfiguration(config);
            CSReporter.info(`Request method set to: ${method.toUpperCase()}`);
        } else {
            throw new Error('No performance scenario configured. Use a setup step first.');
        }
    }

    @CSBDDStepDef('I set the think time to {int} milliseconds')
    static setThinkTime(thinkTime: number): void {
        if (this.currentScenario) {
            const config = this.currentScenario.getConfiguration();
            config.loadConfig.thinkTime = thinkTime;
            this.currentScenario.updateConfiguration(config);
            CSReporter.info(`Think time set to: ${thinkTime}ms`);
        } else {
            throw new Error('No performance scenario configured. Use a setup step first.');
        }
    }

    @CSBDDStepDef('I set the response time threshold to {int} milliseconds')
    static setResponseTimeThreshold(threshold: number): void {
        if (this.currentScenario) {
            const config = this.currentScenario.getConfiguration();
            if (!config.thresholds.responseTime) {
                config.thresholds.responseTime = {};
            }
            config.thresholds.responseTime.average = threshold;
            this.currentScenario.updateConfiguration(config);
            CSReporter.info(`Response time threshold set to: ${threshold}ms`);
        } else {
            throw new Error('No performance scenario configured. Use a setup step first.');
        }
    }

    @CSBDDStepDef('I set the error rate threshold to {float} percent')
    static setErrorRateThreshold(threshold: number): void {
        if (this.currentScenario) {
            const config = this.currentScenario.getConfiguration();
            if (!config.thresholds.errorRate) {
                config.thresholds.errorRate = {};
            }
            config.thresholds.errorRate.maximum = threshold;
            this.currentScenario.updateConfiguration(config);
            CSReporter.info(`Error rate threshold set to: ${threshold}%`);
        } else {
            throw new Error('No performance scenario configured. Use a setup step first.');
        }
    }

    // ===============================================================================
    // WHEN STEPS - Test Execution
    // ===============================================================================

    @CSBDDStepDef('I execute the performance test')
    static async executePerformanceTest(): Promise<void> {
        if (!this.currentScenario) {
            throw new Error('No performance scenario configured. Use a setup step first.');
        }

        CSReporter.info('Executing performance test...');

        try {
            const config = this.currentScenario.getConfiguration();
            const result = await this.performanceRunner.runScenario(config);
            this.testResults.set(config.id, result);

            CSReporter.info(`Performance test completed: ${result.status}`);
            CSReporter.info(`Total requests: ${result.summary.totalRequests}`);
            CSReporter.info(`Success rate: ${result.summary.testEfficiency.toFixed(1)}%`);
            CSReporter.info(`Average response time: ${result.summary.averageResponseTime.toFixed(0)}ms`);
        } catch (error) {
            CSReporter.error(`Performance test failed: ${(error as Error).message}`);
            throw error;
        }
    }

    @CSBDDStepDef('I run the performance test for {int} seconds')
    static async runPerformanceTestForDuration(duration: number): Promise<void> {
        if (!this.currentScenario) {
            throw new Error('No performance scenario configured. Use a setup step first.');
        }

        // Update duration
        const config = this.currentScenario.getConfiguration();
        config.loadConfig.duration = duration;
        this.currentScenario.updateConfiguration(config);

        await this.executePerformanceTest();
    }

    @CSBDDStepDef('I start the performance test')
    static async startPerformanceTest(): Promise<void> {
        // Same as execute for now, but could be enhanced for async execution
        await this.executePerformanceTest();
    }

    @CSBDDStepDef('I stop the performance test')
    static async stopPerformanceTest(): Promise<void> {
        if (!this.currentScenario) {
            throw new Error('No performance scenario configured.');
        }

        const config = this.currentScenario.getConfiguration();
        const testResult = this.testResults.get(config.id);

        if (testResult && testResult.status === 'running') {
            await this.performanceRunner.stopTest(testResult.testId);
            CSReporter.info('Performance test stopped');
        } else {
            CSReporter.warn('No running performance test to stop');
        }
    }

    // ===============================================================================
    // THEN STEPS - Assertions and Validations
    // ===============================================================================

    @CSBDDStepDef('the response time should be less than {int} milliseconds')
    static validateResponseTime(maxResponseTime: number): void {
        const lastResult = this.getLastTestResult();
        const avgResponseTime = lastResult.summary.averageResponseTime;

        if (avgResponseTime > maxResponseTime) {
            throw new Error(`Average response time ${avgResponseTime.toFixed(0)}ms exceeds threshold ${maxResponseTime}ms`);
        }

        CSReporter.info(`✓ Response time ${avgResponseTime.toFixed(0)}ms is within threshold ${maxResponseTime}ms`);
    }

    @CSBDDStepDef('the 95th percentile response time should be less than {int} milliseconds')
    static validate95thPercentileResponseTime(maxResponseTime: number): void {
        const lastResult = this.getLastTestResult();

        // Get the latest metrics for percentile data
        if (lastResult.metrics.length === 0) {
            throw new Error('No performance metrics available');
        }

        const latestMetrics = lastResult.metrics[lastResult.metrics.length - 1];
        const p95ResponseTime = latestMetrics.timing.percentile95;

        if (p95ResponseTime > maxResponseTime) {
            throw new Error(`95th percentile response time ${p95ResponseTime.toFixed(0)}ms exceeds threshold ${maxResponseTime}ms`);
        }

        CSReporter.info(`✓ 95th percentile response time ${p95ResponseTime.toFixed(0)}ms is within threshold ${maxResponseTime}ms`);
    }

    @CSBDDStepDef('the error rate should be less than {float} percent')
    static validateErrorRate(maxErrorRate: number): void {
        const lastResult = this.getLastTestResult();
        const errorRate = lastResult.summary.errorRate;

        if (errorRate > maxErrorRate) {
            throw new Error(`Error rate ${errorRate.toFixed(2)}% exceeds threshold ${maxErrorRate}%`);
        }

        CSReporter.info(`✓ Error rate ${errorRate.toFixed(2)}% is within threshold ${maxErrorRate}%`);
    }

    @CSBDDStepDef('the throughput should be at least {float} requests per second')
    static validateThroughput(minThroughput: number): void {
        const lastResult = this.getLastTestResult();
        const throughput = lastResult.summary.throughput;

        if (throughput < minThroughput) {
            throw new Error(`Throughput ${throughput.toFixed(2)} RPS is below threshold ${minThroughput} RPS`);
        }

        CSReporter.info(`✓ Throughput ${throughput.toFixed(2)} RPS meets minimum requirement ${minThroughput} RPS`);
    }

    @CSBDDStepDef('there should be no critical threshold violations')
    static validateNoCriticalViolations(): void {
        const lastResult = this.getLastTestResult();
        const criticalViolations = lastResult.thresholdViolations.filter((v: { severity: string }) => v.severity === 'critical');

        if (criticalViolations.length > 0) {
            const violations = criticalViolations.map((v: { description: string }) => v.description).join(', ');
            throw new Error(`Critical threshold violations found: ${violations}`);
        }

        CSReporter.info('✓ No critical threshold violations found');
    }

    @CSBDDStepDef('the test should complete successfully')
    static validateTestCompletion(): void {
        const lastResult = this.getLastTestResult();

        if (lastResult.status !== 'completed') {
            throw new Error(`Test did not complete successfully. Status: ${lastResult.status}`);
        }

        CSReporter.info('✓ Performance test completed successfully');
    }

    @CSBDDStepDef('the success rate should be at least {float} percent')
    static validateSuccessRate(minSuccessRate: number): void {
        const lastResult = this.getLastTestResult();
        const successRate = lastResult.summary.testEfficiency;

        if (successRate < minSuccessRate) {
            throw new Error(`Success rate ${successRate.toFixed(1)}% is below threshold ${minSuccessRate}%`);
        }

        CSReporter.info(`✓ Success rate ${successRate.toFixed(1)}% meets minimum requirement ${minSuccessRate}%`);
    }

    @CSBDDStepDef('I should see performance metrics')
    static validateMetricsExist(): void {
        const lastResult = this.getLastTestResult();

        if (lastResult.metrics.length === 0) {
            throw new Error('No performance metrics were collected');
        }

        CSReporter.info(`✓ Performance metrics collected: ${lastResult.metrics.length} data points`);
    }

    // ===============================================================================
    // Helper Methods
    // ===============================================================================

    private static getLastTestResult(): PerformanceTestResult {
        if (this.testResults.size === 0) {
            throw new Error('No performance test results available. Run a performance test first.');
        }

        const results = Array.from(this.testResults.values());
        return results[results.length - 1];
    }

    /**
     * Clear test results (for cleanup between scenarios)
     */
    static clearTestResults(): void {
        this.testResults.clear();
        this.currentScenario = null;
        CSReporter.debug('Performance test results cleared');
    }

    /**
     * Get current scenario configuration
     */
    static getCurrentScenario(): any {
        return this.currentScenario;
    }

    /**
     * Get all test results
     */
    static getAllTestResults(): PerformanceTestResult[] {
        return Array.from(this.testResults.values());
    }

    /**
     * Set custom configuration for advanced scenarios
     */
    @CSBDDStepDef('I configure the performance test with custom settings')
    static configureCustomSettings(): void {
        // This step can be extended to read from configuration files or data tables
        CSReporter.info('Custom performance configuration can be implemented here');
    }

    // ===============================================================================
    // UI PERFORMANCE TESTING BDD STEPS
    // ===============================================================================

    // Core Web Vitals Testing Steps

    @CSBDDStepDef('I have a Core Web Vitals test for page {string}')
    static setupCoreWebVitalsTest(pageUrl: string): void {
        CSReporter.info(`Setting up Core Web Vitals test for: ${pageUrl}`);

        this.currentScenario = CSCoreWebVitalsScenario.createCoreWebVitalsTest({
            name: `Core Web Vitals - ${pageUrl}`,
            pages: [pageUrl],
            iterations: 3
        });
    }

    @CSBDDStepDef('I have a Core Web Vitals test for multiple pages')
    static setupMultiPageCoreWebVitalsTest(dataTable: any): void {
        const pages = dataTable.hashes().map((row: any) => row.url);
        CSReporter.info(`Setting up Core Web Vitals test for ${pages.length} pages`);

        this.currentScenario = CSCoreWebVitalsScenario.createCoreWebVitalsTest({
            name: 'Core Web Vitals - Multi Page',
            pages: pages,
            iterations: 3
        });
    }

    @CSBDDStepDef('I set the browser to {string}')
    static setBrowser(browserType: string): void {
        if (!this.currentScenario) {
            throw new Error('No performance scenario configured. Use a setup step first.');
        }

        CSReporter.info(`Setting browser to: ${browserType}`);
        const validBrowsers = ['chromium', 'firefox', 'webkit'];

        if (!validBrowsers.includes(browserType)) {
            throw new Error(`Invalid browser type: ${browserType}. Valid options: ${validBrowsers.join(', ')}`);
        }

        const config = this.currentScenario.getConfiguration();
        if (config.browserConfig) {
            config.browserConfig.browserType = browserType;
        } else {
            config.browserConfig = { browserType };
        }

        this.currentScenario.updateConfiguration(config);
    }

    @CSBDDStepDef('I enable mobile emulation for {string}')
    static enableMobileEmulation(deviceName: string): void {
        if (!this.currentScenario) {
            throw new Error('No performance scenario configured. Use a setup step first.');
        }

        CSReporter.info(`Enabling mobile emulation for: ${deviceName}`);
        const config = this.currentScenario.getConfiguration();

        if (config.browserConfig) {
            config.browserConfig.deviceEmulation = deviceName;
            config.browserConfig.viewport = this.getMobileViewport(deviceName);
        } else {
            config.browserConfig = {
                deviceEmulation: deviceName,
                viewport: this.getMobileViewport(deviceName)
            };
        }

        this.currentScenario.updateConfiguration(config);
    }

    @CSBDDStepDef('I set network throttling to {string}')
    static setNetworkThrottling(throttlingType: string): void {
        if (!this.currentScenario) {
            throw new Error('No performance scenario configured. Use a setup step first.');
        }

        CSReporter.info(`Setting network throttling to: ${throttlingType}`);
        const config = this.currentScenario.getConfiguration();

        const throttlingConfig = this.getThrottlingConfig(throttlingType);

        if (config.browserConfig) {
            config.browserConfig.networkThrottling = throttlingConfig;
        } else {
            config.browserConfig = { networkThrottling: throttlingConfig };
        }

        this.currentScenario.updateConfiguration(config);
    }

    // Page Load Performance Steps

    @CSBDDStepDef('I have a page load performance test for {string}')
    static setupPageLoadTest(pageUrl: string): void {
        CSReporter.info(`Setting up page load performance test for: ${pageUrl}`);

        this.currentScenario = CSPageLoadPerformanceScenario.createPageLoadTest({
            name: `Page Load Test - ${pageUrl}`,
            pages: [{ url: pageUrl }],
            iterations: 5
        });
    }

    @CSBDDStepDef('I have a UI load test with {int} browsers for {int} seconds')
    static setupUILoadTest(browsers: number, duration: number): void {
        CSReporter.info(`Setting up UI load test: ${browsers} browsers for ${duration} seconds`);

        const targetUrl = this.config.get('PERFORMANCE_TARGET_URL', 'url');

        this.currentScenario = CSUILoadTestScenario.createUILoadTest({
            name: `UI Load Test - ${browsers} browsers`,
            pages: [targetUrl],
            virtualUsers: browsers,
            duration: duration
        });
    }

    @CSBDDStepDef('I have a visual regression test for page {string}')
    static setupVisualRegressionTest(pageUrl: string): void {
        CSReporter.info(`Setting up visual regression test for: ${pageUrl}`);

        this.currentScenario = CSVisualRegressionPerformanceScenario.createVisualRegressionTest({
            name: `Visual Regression - ${pageUrl}`,
            pages: [pageUrl]
        });
    }

    // Core Web Vitals Assertions
    // NOTE: These steps are templates for future UI performance testing implementation
    // They are commented out until the PerformanceTestResult interface is extended with UI metrics

    /* TODO: Uncomment when UI metrics are added to PerformanceTestResult interface
    @CSBDDStepDef('the Largest Contentful Paint should be less than {int} milliseconds')
    static verifyLCPMetric(maxLCP: number): void {
        const results = this.getLastTestResult();
        if (!results || !results.uiMetrics) {
            throw new Error('No UI performance results available');
        }

        const latestMetrics = results.uiMetrics[results.uiMetrics.length - 1];
        const lcp = latestMetrics?.webVitals?.lcp;

        if (lcp === undefined) {
            throw new Error('LCP measurement not available');
        }

        if (lcp > maxLCP) {
            throw new Error(`LCP ${lcp}ms exceeds maximum threshold ${maxLCP}ms`);
        }

        CSReporter.info(`✓ LCP ${lcp}ms is within acceptable threshold ${maxLCP}ms`);
    }

    @CSBDDStepDef('the First Input Delay should be less than {int} milliseconds')
    static verifyFID(maxFID: number): void {
        const results = this.getLastTestResult();
        if (!results || !results.uiMetrics) {
            throw new Error('No UI performance results available');
        }

        const latestMetrics = results.uiMetrics[results.uiMetrics.length - 1];
        const fid = latestMetrics?.webVitals?.fid;

        if (fid === undefined) {
            throw new Error('FID measurement not available');
        }

        if (fid > maxFID) {
            throw new Error(`FID ${fid}ms exceeds maximum threshold ${maxFID}ms`);
        }

        CSReporter.info(`✓ FID ${fid}ms is within acceptable threshold ${maxFID}ms`);
    }

    @CSBDDStepDef('the Cumulative Layout Shift should be less than {float}')
    static verifyCLS(maxCLS: number): void {
        const results = this.getLastTestResult();
        if (!results || !results.uiMetrics) {
            throw new Error('No UI performance results available');
        }

        const latestMetrics = results.uiMetrics[results.uiMetrics.length - 1];
        const cls = latestMetrics?.webVitals?.cls;

        if (cls === undefined) {
            throw new Error('CLS measurement not available');
        }

        if (cls > maxCLS) {
            throw new Error(`CLS ${cls} exceeds maximum threshold ${maxCLS}`);
        }

        CSReporter.info(`✓ CLS ${cls} is within acceptable threshold ${maxCLS}`);
    }

    @CSBDDStepDef('the First Contentful Paint should be less than {int} milliseconds')
    static verifyFCP(maxFCP: number): void {
        const results = this.getLastTestResult();
        if (!results || !results.uiMetrics) {
            throw new Error('No UI performance results available');
        }

        const latestMetrics = results.uiMetrics[results.uiMetrics.length - 1];
        const fcp = latestMetrics?.webVitals?.fcp;

        if (fcp === undefined) {
            throw new Error('FCP measurement not available');
        }

        if (fcp > maxFCP) {
            throw new Error(`FCP ${fcp}ms exceeds maximum threshold ${maxFCP}ms`);
        }

        CSReporter.info(`✓ FCP ${fcp}ms is within acceptable threshold ${maxFCP}ms`);
    }

    @CSBDDStepDef('the page load should complete in less than {int} seconds')
    static verifyPageLoadTime(maxSeconds: number): void {
        const results = this.getLastTestResult();
        if (!results || !results.pageLoadResults) {
            throw new Error('No page load results available');
        }

        const latestPageLoad = results.pageLoadResults[results.pageLoadResults.length - 1];
        const loadTimeSeconds = latestPageLoad.loadTime / 1000;

        if (loadTimeSeconds > maxSeconds) {
            throw new Error(`Page load time ${loadTimeSeconds.toFixed(2)}s exceeds maximum ${maxSeconds}s`);
        }

        CSReporter.info(`✓ Page load time ${loadTimeSeconds.toFixed(2)}s is within acceptable threshold ${maxSeconds}s`);
    }

    @CSBDDStepDef('the Core Web Vitals score should be {string}')
    static verifyCoreWebVitalsScore(expectedScore: string): void {
        const results = this.getLastTestResult();
        if (!results || !results.webVitalsScore) {
            throw new Error('No Core Web Vitals scores available');
        }

        const validScores = ['good', 'needs-improvement', 'poor'];
        if (!validScores.includes(expectedScore)) {
            throw new Error(`Invalid score ${expectedScore}. Valid options: ${validScores.join(', ')}`);
        }

        const overallScore = results.webVitalsScores.overall;

        if (overallScore !== expectedScore) {
            throw new Error(`Core Web Vitals overall score is '${overallScore}', expected '${expectedScore}'`);
        }

        CSReporter.info(`✓ Core Web Vitals overall score is '${overallScore}' as expected`);
    }

    @CSBDDStepDef('there should be no visual differences')
    static verifyNoVisualDifferences(): void {
        const results = this.getLastTestResult();
        if (!results || !results.visualResults) {
            throw new Error('No visual comparison results available');
        }

        const failedComparisons = results.visualResults.filter((result: any) => !result.passed);

        if (failedComparisons.length > 0) {
            const failureDetails = failedComparisons.map((f: any) =>
                `${f.pageName}: ${f.differencePercentage.toFixed(3)}% difference`
            ).join(', ');
            throw new Error(`Visual differences detected: ${failureDetails}`);
        }

        CSReporter.info(`✓ No visual differences detected across ${results.visualResults.length} comparison(s)`);
    }
    */

    // Helper methods for UI performance testing

    private static getMobileViewport(deviceName: string): { width: number; height: number } {
        const devices: Record<string, { width: number; height: number }> = {
            'iPhone 12': { width: 390, height: 844 },
            'iPad': { width: 768, height: 1024 },
            'Samsung Galaxy S21': { width: 384, height: 854 },
            'Pixel 5': { width: 393, height: 851 }
        };

        return devices[deviceName] || { width: 375, height: 667 }; // Default mobile viewport
    }

    private static getThrottlingConfig(throttlingType: string): any {
        const configs: Record<string, any> = {
            'slow-3g': {
                downloadSpeed: 500 * 1024, // 500 KB/s
                uploadSpeed: 500 * 1024,
                latency: 400
            },
            'fast-3g': {
                downloadSpeed: 1.6 * 1024 * 1024, // 1.6 MB/s
                uploadSpeed: 750 * 1024,
                latency: 150
            },
            '4g': {
                downloadSpeed: 4 * 1024 * 1024, // 4 MB/s
                uploadSpeed: 3 * 1024 * 1024,
                latency: 20
            }
        };

        return configs[throttlingType] || null;
    }

    private static getLatestTestResult(): any {
        const results = Array.from(this.testResults.values());
        return results.length > 0 ? results[results.length - 1] : null;
    }
}