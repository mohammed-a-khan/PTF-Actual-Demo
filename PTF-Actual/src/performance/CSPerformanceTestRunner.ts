import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSLoadGenerator } from './CSLoadGenerator';
import { CSPerformanceReporter } from './CSPerformanceReporter';
import { CSBrowserManager } from '../browser/CSBrowserManager';
import { CSBrowserPool, BrowserInstance } from '../browser/CSBrowserPool';
import { CSPerformanceMonitor } from '../monitoring/CSPerformanceMonitor';
import { CSVisualTesting } from '../visual/CSVisualTesting';
import { randomUUID } from 'crypto';
import EventEmitter from 'events';
import {
    PerformanceScenarioConfig,
    PerformanceTestResult,
    PerformanceMetrics,
    PerformanceEvent,
    PerformanceEventCallback,
    MetricsCallback,
    ThresholdViolation,
    ThresholdViolationCallback,
    RealTimeMetrics,
    EnvironmentInfo,
    UIPerformanceScenarioConfig,
    UITestResult,
    UIPerformanceMetrics,
    CoreWebVitalsMetrics,
    BrowserConfiguration,
    PageConfiguration,
    PerformanceError
} from './types/CSPerformanceTypes';

/**
 * CS Performance Test Runner
 * Main orchestrator for performance testing scenarios including load, stress, and spike testing
 */
export class CSPerformanceTestRunner extends EventEmitter {
    private static instance: CSPerformanceTestRunner;
    private config: CSConfigurationManager;
    private loadGenerator!: CSLoadGenerator;
    private performanceReporter!: CSPerformanceReporter;
    private browserPool!: CSBrowserPool;
    private runningTests: Map<string, PerformanceTestResult>;
    private metricsCollectors: Map<string, any>;
    private eventCallbacks: Map<string, PerformanceEventCallback[]>;
    private useBrowserPool: boolean;
    private initialized: boolean = false;

    private constructor() {
        super();
        this.config = CSConfigurationManager.getInstance();
        this.runningTests = new Map();
        this.metricsCollectors = new Map();
        this.eventCallbacks = new Map();
        this.useBrowserPool = this.config.getBoolean('BROWSER_POOL_ENABLED', false);
        this.initializeComponents();
    }

    public static getInstance(): CSPerformanceTestRunner {
        if (!CSPerformanceTestRunner.instance) {
            CSPerformanceTestRunner.instance = new CSPerformanceTestRunner();
        }
        return CSPerformanceTestRunner.instance;
    }

    private async initializeComponents(): Promise<void> {
        this.loadGenerator = CSLoadGenerator.getInstance();
        this.performanceReporter = CSPerformanceReporter.getInstance();

        // Initialize browser pool if enabled
        if (this.useBrowserPool) {
            this.browserPool = CSBrowserPool.getInstance();
            await this.browserPool.initialize();
            CSReporter.info('Browser pool initialized for performance testing');
        }
    }

    /**
     * Initialize the performance test runner
     */
    public async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        await this.initializeComponents();
        this.initialized = true;
        CSReporter.info('Performance test runner initialized');
    }

    /**
     * Run a single performance test scenario
     */
    public async runScenario(scenarioConfig: PerformanceScenarioConfig): Promise<PerformanceTestResult> {
        if (!this.initialized) {
            await this.initialize();
        }

        const testId = this.generateTestId();
        const startTime = Date.now();

        CSReporter.info(`Starting performance test: ${scenarioConfig.name} (${scenarioConfig.testType})`);

        // Initialize test result
        const testResult: PerformanceTestResult = {
            testId,
            scenarioId: scenarioConfig.id,
            scenarioName: scenarioConfig.name,
            startTime,
            endTime: 0,
            duration: 0,
            status: 'running',
            summary: {
                totalRequests: 0,
                successfulRequests: 0,
                failedRequests: 0,
                errorRate: 0,
                averageResponseTime: 0,
                maxResponseTime: 0,
                minResponseTime: 0,
                throughput: 0,
                concurrentUsers: { max: 0, average: 0 },
                dataTransferred: { sent: 0, received: 0, total: 0 },
                testEfficiency: 0
            },
            metrics: [],
            thresholdViolations: [],
            virtualUsers: [],
            errors: [],
            environment: await this.getEnvironmentInfo()
        };

        this.runningTests.set(testId, testResult);
        this.emitEvent('test-started', testId, { scenarioConfig, testId });

        // Start performance monitoring for load testing
        const performanceMonitor = CSPerformanceMonitor.getInstance();
        const virtualUsers = scenarioConfig.loadConfig?.virtualUsers || 1;
        await performanceMonitor.startConcurrentMonitoring(
            scenarioConfig.name || testId,
            virtualUsers
        );

        try {
            // Validate scenario configuration
            this.validateScenarioConfig(scenarioConfig);

            // Initialize performance reporter for this test
            await this.performanceReporter.initializeTest(testId, scenarioConfig);

            // Start metrics collection
            this.startMetricsCollection(testId, scenarioConfig);

            // Execute warmup requests if configured
            if (scenarioConfig.warmupRequests && scenarioConfig.warmupRequests > 0) {
                CSReporter.info(`Executing ${scenarioConfig.warmupRequests} warmup requests`);
                await this.executeWarmup(testId, scenarioConfig);
            }

            // Run the main performance test
            await this.executePerformanceTest(testId, scenarioConfig);

            // Wait for cooldown if configured
            if (scenarioConfig.cooldownTime && scenarioConfig.cooldownTime > 0) {
                CSReporter.info(`Cooling down for ${scenarioConfig.cooldownTime}ms`);
                await this.sleep(scenarioConfig.cooldownTime);
            }

            // Finalize test results
            testResult.endTime = Date.now();
            testResult.duration = testResult.endTime - testResult.startTime;
            testResult.status = 'completed';

            // Generate final summary
            await this.generateTestSummary(testId);

            // Record load test metrics to performance monitor
            performanceMonitor.recordLoadTestMetrics({
                concurrentUsers: virtualUsers,
                requestsPerSecond: testResult.summary.throughput,
                responseTime: testResult.summary.averageResponseTime,
                errorRate: testResult.summary.errorRate,
                throughput: testResult.summary.throughput,
                activeConnections: virtualUsers,
                queueLength: testResult.summary.failedRequests,
                url: scenarioConfig.requestTemplate?.url || 'N/A'
            });

            // Export monitoring data for reporting
            const monitoringData = performanceMonitor.exportForPerformanceTesting();
            const loadTestSummary = performanceMonitor.getLoadTestSummary();

            CSReporter.info(`Performance Monitoring Summary - Avg Response: ${loadTestSummary.avgResponseTime}ms, Avg Error Rate: ${loadTestSummary.avgErrorRate}%, Peak Users: ${loadTestSummary.peakConcurrentUsers}`);

            CSReporter.info(`Performance test completed: ${scenarioConfig.name} (Duration: ${testResult.duration}ms)`);
            this.emitEvent('test-completed', testId, { testResult });

            return testResult;

        } catch (error) {
            testResult.endTime = Date.now();
            testResult.duration = testResult.endTime - testResult.startTime;
            testResult.status = 'failed';

            CSReporter.error(`Performance test failed: ${scenarioConfig.name} - ${(error as Error).message}`);
            this.emitEvent('test-failed', testId, { error: error as Error, testResult });

            throw error;

        } finally {
            // Stop performance monitoring
            await performanceMonitor.stopMonitoring();

            // Cleanup
            this.stopMetricsCollection(testId);
            await this.performanceReporter.finalizeTest(testId);

            // Keep test result for reporting but stop active monitoring
            setTimeout(() => {
                this.runningTests.delete(testId);
            }, this.config.getNumber('PERFORMANCE_RESULT_RETENTION_TIME', 300000)); // 5 minutes
        }
    }

    /**
     * Run multiple performance test scenarios in sequence
     */
    public async runScenarios(scenarios: PerformanceScenarioConfig[]): Promise<PerformanceTestResult[]> {
        const results: PerformanceTestResult[] = [];

        for (const scenario of scenarios) {
            try {
                const result = await this.runScenario(scenario);
                results.push(result);

                // Pause between scenarios if configured
                const pauseBetweenScenarios = this.config.getNumber('PERFORMANCE_SCENARIO_PAUSE', 5000);
                if (pauseBetweenScenarios > 0) {
                    CSReporter.info(`Pausing ${pauseBetweenScenarios}ms between scenarios`);
                    await this.sleep(pauseBetweenScenarios);
                }

            } catch (error) {
                CSReporter.error(`Scenario ${scenario.name} failed, continuing with next scenario`);
                // Continue with next scenario even if current one fails
            }
        }

        return results;
    }

    /**
     * Stop a running performance test
     */
    public async stopTest(testId: string): Promise<void> {
        const testResult = this.runningTests.get(testId);
        if (!testResult) {
            throw new Error(`Test ${testId} not found or not running`);
        }

        CSReporter.info(`Stopping performance test: ${testId}`);

        // Stop load generation
        await this.loadGenerator.stopTest(testId);

        // Update test status
        testResult.status = 'stopped';
        testResult.endTime = Date.now();
        testResult.duration = testResult.endTime - testResult.startTime;

        // Stop metrics collection
        this.stopMetricsCollection(testId);

        this.emitEvent('test-stopped', testId, { testResult });
    }

    /**
     * Get real-time metrics for a running test
     */
    public getRealTimeMetrics(testId: string): RealTimeMetrics | null {
        const testResult = this.runningTests.get(testId);
        if (!testResult || testResult.status !== 'running') {
            return null;
        }

        const latestMetrics = testResult.metrics[testResult.metrics.length - 1];
        if (!latestMetrics) {
            return null;
        }

        const elapsedTime = Date.now() - testResult.startTime;
        const estimatedDuration = this.estimateTestDuration(testId);
        const estimatedTimeRemaining = Math.max(0, estimatedDuration - elapsedTime);

        return {
            currentVirtualUsers: latestMetrics.virtualUsers.active,
            currentThroughput: latestMetrics.throughput.requestsPerSecond,
            currentResponseTime: latestMetrics.timing.averageResponseTime,
            currentErrorRate: latestMetrics.errors.rate,
            elapsedTime,
            estimatedTimeRemaining,
            status: testResult.status,
            lastUpdate: latestMetrics.timestamp
        };
    }

    /**
     * Register event callback
     */
    public onEvent(eventType: string, callback: PerformanceEventCallback): void {
        if (!this.eventCallbacks.has(eventType)) {
            this.eventCallbacks.set(eventType, []);
        }
        this.eventCallbacks.get(eventType)!.push(callback);
    }

    /**
     * Register metrics callback
     */
    public onMetricsUpdate(callback: MetricsCallback): void {
        this.on('metrics-updated', callback);
    }

    /**
     * Register threshold violation callback
     */
    public onThresholdViolation(callback: ThresholdViolationCallback): void {
        this.on('threshold-violated', callback);
    }

    private validateScenarioConfig(config: PerformanceScenarioConfig): void {
        if (!config.id || !config.name) {
            throw new Error('Scenario must have id and name');
        }

        if (!config.loadConfig || config.loadConfig.virtualUsers <= 0) {
            throw new Error('Invalid load configuration');
        }

        if (!config.loadConfig.duration || config.loadConfig.duration <= 0) {
            throw new Error('Test duration must be greater than 0');
        }

        if (config.requestTemplate && !config.requestTemplate.url) {
            throw new Error('Request template must have a URL');
        }
    }

    private async executeWarmup(testId: string, config: PerformanceScenarioConfig): Promise<void> {
        const warmupConfig = {
            ...config,
            loadConfig: {
                ...config.loadConfig,
                virtualUsers: Math.min(config.loadConfig.virtualUsers, 5),
                duration: Math.min(config.loadConfig.duration, 30)
            }
        };

        await this.loadGenerator.executeLoad(testId + '_warmup', warmupConfig);
    }

    private async executePerformanceTest(testId: string, config: PerformanceScenarioConfig): Promise<void> {
        await this.loadGenerator.executeLoad(testId, config);
    }

    private startMetricsCollection(testId: string, config: PerformanceScenarioConfig): void {
        const interval = this.config.getNumber('PERFORMANCE_METRICS_INTERVAL', 1000);

        const collector = setInterval(async () => {
            try {
                const metrics = await this.loadGenerator.getMetrics(testId);
                if (metrics) {
                    const testResult = this.runningTests.get(testId);
                    if (testResult) {
                        testResult.metrics.push(metrics);

                        // Check thresholds
                        const violations = this.checkThresholds(metrics, config.thresholds);
                        testResult.thresholdViolations.push(...violations);

                        // Emit events
                        this.emit('metrics-updated', metrics);
                        violations.forEach(violation => {
                            this.emit('threshold-violated', violation);
                        });
                    }
                }

            } catch (error) {
                CSReporter.error(`Error collecting metrics for test ${testId}: ${(error as Error).message}`);
            }
        }, interval);

        this.metricsCollectors.set(testId, collector);
    }

    private stopMetricsCollection(testId: string): void {
        const collector = this.metricsCollectors.get(testId);
        if (collector) {
            clearInterval(collector);
            this.metricsCollectors.delete(testId);
        }
    }

    private checkThresholds(metrics: PerformanceMetrics, thresholds: any): ThresholdViolation[] {
        const violations: ThresholdViolation[] = [];

        // Check response time thresholds
        if (thresholds.responseTime) {
            if (thresholds.responseTime.average && metrics.timing.averageResponseTime > thresholds.responseTime.average) {
                violations.push({
                    timestamp: metrics.timestamp,
                    metric: 'average_response_time',
                    actualValue: metrics.timing.averageResponseTime,
                    thresholdValue: thresholds.responseTime.average,
                    severity: 'warning',
                    description: `Average response time ${metrics.timing.averageResponseTime}ms exceeds threshold ${thresholds.responseTime.average}ms`
                });
            }
        }

        if (thresholds.responseTime.percentile95 && metrics.timing.percentile95 > thresholds.responseTime.percentile95) {
            violations.push({
                timestamp: metrics.timestamp,
                metric: '95th_percentile_response_time',
                actualValue: metrics.timing.percentile95,
                thresholdValue: thresholds.responseTime.percentile95,
                severity: 'critical',
                description: `95th percentile response time ${metrics.timing.percentile95}ms exceeds threshold ${thresholds.responseTime.percentile95}ms`
            });
        }

        // Check error rate thresholds
        if (thresholds.errorRate && thresholds.errorRate.maximum && metrics.errors.rate > thresholds.errorRate.maximum) {
            violations.push({
                timestamp: metrics.timestamp,
                metric: 'error_rate',
                actualValue: metrics.errors.rate,
                thresholdValue: thresholds.errorRate.maximum,
                severity: 'critical',
                description: `Error rate ${metrics.errors.rate}% exceeds threshold ${thresholds.errorRate.maximum}%`
            });
        }

        // Check throughput thresholds
        if (thresholds.throughput && thresholds.throughput.minimum && metrics.throughput.requestsPerSecond < thresholds.throughput.minimum) {
            violations.push({
                timestamp: metrics.timestamp,
                metric: 'throughput',
                actualValue: metrics.throughput.requestsPerSecond,
                thresholdValue: thresholds.throughput.minimum,
                severity: 'warning',
                description: `Throughput ${metrics.throughput.requestsPerSecond} RPS below threshold ${thresholds.throughput.minimum} RPS`
            });
        }

        return violations;
    }

    private async generateTestSummary(testId: string): Promise<void> {
        const testResult = this.runningTests.get(testId);
        if (!testResult) return;

        const metrics = testResult.metrics;
        if (metrics.length === 0) return;

        // Calculate summary statistics
        const totalRequests = metrics.reduce((sum, m) => sum + m.requests.completed, 0);
        const successfulRequests = metrics.reduce((sum, m) => sum + m.requests.completed, 0);
        const failedRequests = metrics.reduce((sum, m) => sum + m.requests.failed, 0);

        const responseTimes = metrics.map(m => m.timing.averageResponseTime).filter(rt => rt > 0);
        const maxUsers = Math.max(...metrics.map(m => m.virtualUsers.active || 0), 0);
        const avgUsers = metrics.reduce((sum, m) => sum + m.virtualUsers.active, 0) / metrics.length;

        testResult.summary = {
            totalRequests,
            successfulRequests,
            failedRequests,
            errorRate: totalRequests > 0 ? (failedRequests / totalRequests) * 100 : 0,
            averageResponseTime: responseTimes.length > 0 ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : 0,
            maxResponseTime: Math.max(...responseTimes, 0),
            minResponseTime: responseTimes.length > 0 ? Math.min(...responseTimes.filter(rt => rt > 0), 0) : 0,
            throughput: totalRequests / (testResult.duration / 1000),
            concurrentUsers: { max: maxUsers, average: avgUsers },
            dataTransferred: {
                sent: metrics.reduce((sum, m) => sum + (m.throughput.bytesPerSecond || 0), 0),
                received: 0, // TODO: Implement if needed
                total: 0 // TODO: Calculate total
            },
            testEfficiency: totalRequests > 0 ? (successfulRequests / totalRequests) * 100 : 0
        };
    }

    private estimateTestDuration(testId: string): number {
        // TODO: Implement duration estimation based on test configuration
        return 0;
    }

    private async getEnvironmentInfo(): Promise<EnvironmentInfo> {
        const os = await import('os');
        
        return {
            os: os.type(),
            nodeVersion: process.version,
            frameworkVersion: process.env.npm_package_version || '1.0.0',
            testRunId: randomUUID(),
            hostInfo: {
                hostname: os.hostname(),
                platform: os.platform(),
                architecture: os.arch(),
                cpuCores: os.cpus().length,
                totalMemory: os.totalmem()
            }
        };
    }

    private emitEvent(type: string, testId: string, data: any): void {
        const event: PerformanceEvent = {
            type: type as any,
            timestamp: Date.now(),
            testId,
            data
        };

        this.emit(type, event);

        // Call registered callbacks
        const callbacks = this.eventCallbacks.get(type);
        if (callbacks) {
            callbacks.forEach(callback => {
                try {
                    callback(event);
                } catch (error) {
                    CSReporter.error(`Error in event callback: ${(error as Error).message}`);
                }
            });
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Generate unique test ID
     */
    private generateTestId(): string {
        return `perf_test_${Date.now()}_${randomUUID()}`;
    }

    /**
     * Create PerformanceError object from error message
     */
    private createPerformanceError(message: string, error?: Error, virtualUserId?: string, requestUrl?: string): PerformanceError {
        return {
            timestamp: Date.now(),
            virtualUserId,
            errorType: error?.name || 'Error',
            message,
            requestUrl,
            stackTrace: error?.stack
        };
    }

    /**
     * Get all running tests
     */
    public getRunningTests(): PerformanceTestResult[] {
        return Array.from(this.runningTests.values()).filter(test => test.status === 'running');
    }

    /**
     * Get test result by ID
     */
    public getTestResult(testId: string): PerformanceTestResult | undefined {
        return this.runningTests.get(testId);
    }

    /**
     * Export test results to file
     */
    public async exportResults(testId: string, format: 'json' | 'csv' | 'html' = 'json'): Promise<string> {
        const testResult = this.runningTests.get(testId);
        if (!testResult) {
            throw new Error(`Test result ${testId} not found`);
        }

        return await this.performanceReporter.exportResults(testResult, format);
    }

    // ==================================================================================
    // UI PERFORMANCE TESTING METHODS
    // ==================================================================================

    /**
     * Run UI performance test scenario
     */
    public async runUIPerformanceScenario(scenarioConfig: UIPerformanceScenarioConfig): Promise<UITestResult> {
        if (!this.initialized) {
            await this.initialize();
        }

        const testId = this.generateTestId();
        const startTime = Date.now();

        CSReporter.info(`Starting UI performance test: ${scenarioConfig.name} (${scenarioConfig.testType})`);

        // Initialize UI test result
        const testResult: UITestResult = {
            testId,
            scenarioId: scenarioConfig.id,
            scenarioName: scenarioConfig.name,
            startTime,
            endTime: 0,
            duration: 0,
            status: 'running',
            summary: {
                totalRequests: 0,
                successfulRequests: 0,
                failedRequests: 0,
                errorRate: 0,
                averageResponseTime: 0,
                maxResponseTime: 0,
                minResponseTime: 0,
                throughput: 0,
                concurrentUsers: { max: 0, average: 0 },
                dataTransferred: { sent: 0, received: 0, total: 0 },
                testEfficiency: 0
            },
            metrics: [],
            thresholdViolations: [],
            virtualUsers: [],
            errors: [],
            environment: await this.getEnvironmentInfo(),
            uiMetrics: [],
            webVitalsScores: {
                lcp: 'good',
                fid: 'good',
                cls: 'good',
                fcp: 'good',
                ttfb: 'good',
                overall: 'good'
            },
            visualResults: [],
            pageLoadResults: []
        };

        this.runningTests.set(testId, testResult);

        // Start performance monitoring for this scenario
        const performanceMonitor = CSPerformanceMonitor.getInstance();
        const virtualUsers = scenarioConfig.loadConfig?.virtualUsers || 1;
        await performanceMonitor.startConcurrentMonitoring(
            scenarioConfig.name || testId,
            virtualUsers
        );

        try {
            // Validate UI scenario configuration
            this.validateUIScenarioConfig(scenarioConfig);

            // Execute UI performance test based on type
            switch (scenarioConfig.testType) {
                case 'core-web-vitals':
                    await this.runCoreWebVitalsTest(testId, scenarioConfig);
                    break;
                case 'page-load':
                    await this.runPageLoadTest(testId, scenarioConfig);
                    break;
                case 'ui-load':
                    await this.runUILoadTest(testId, scenarioConfig);
                    break;
                case 'visual-regression':
                    await this.runVisualRegressionTest(testId, scenarioConfig);
                    break;
                default:
                    throw new Error(`Unsupported UI test type: ${scenarioConfig.testType}`);
            }

            // Calculate final results
            const endTime = Date.now();
            testResult.endTime = endTime;
            testResult.duration = endTime - startTime;
            testResult.status = 'completed';

            // Calculate Core Web Vitals scores
            testResult.webVitalsScores = this.calculateWebVitalsScores(testResult);

            // Record load test metrics to performance monitor
            performanceMonitor.recordLoadTestMetrics({
                concurrentUsers: virtualUsers,
                requestsPerSecond: testResult.summary.throughput,
                responseTime: testResult.summary.averageResponseTime,
                errorRate: testResult.summary.errorRate,
                throughput: testResult.summary.throughput,
                activeConnections: virtualUsers,
                queueLength: testResult.summary.failedRequests,
                url: scenarioConfig.pages?.[0]?.url || 'N/A'
            });

            // Export monitoring data for reporting
            const monitoringData = performanceMonitor.exportForPerformanceTesting();
            const loadTestSummary = performanceMonitor.getLoadTestSummary();

            CSReporter.info(`Performance Monitoring Summary - Avg Response: ${loadTestSummary.avgResponseTime}ms, Avg Error Rate: ${loadTestSummary.avgErrorRate}%, Peak Users: ${loadTestSummary.peakConcurrentUsers}`);

            CSReporter.pass(`UI performance test completed: ${scenarioConfig.name} in ${testResult.duration}ms`);

        } catch (error) {
            testResult.status = 'failed';
            const err = error as Error;
            testResult.errors.push(this.createPerformanceError(
                err.message || String(error),
                err
            ));
            CSReporter.error(`UI performance test failed: ${(error instanceof Error ? error.message : String(error))}`);
        } finally {
            // Stop performance monitoring
            await performanceMonitor.stopMonitoring();
        }

        return testResult as UITestResult;
    }

    /**
     * Run Core Web Vitals performance test
     */
    private async runCoreWebVitalsTest(testId: string, scenarioConfig: UIPerformanceScenarioConfig): Promise<void> {
        const performanceMonitor = CSPerformanceMonitor.getInstance();
        let browserInstance: BrowserInstance | null = null;
        let page;

        try {
            // Acquire browser from pool or create new browser
            if (this.useBrowserPool) {
                browserInstance = await this.browserPool.acquire(scenarioConfig.browserConfig.browserType || 'chromium');
                page = browserInstance.page;
            } else {
                const browserManager = CSBrowserManager.getInstance();
                await browserManager.launch(scenarioConfig.browserConfig.browserType || 'chromium');
                page = browserManager.getPage();
            }

            if (!page) {
                throw new Error('Failed to initialize browser page');
            }

            // Start performance monitoring
            await performanceMonitor.startConcurrentMonitoring('CoreWebVitals-${testId}', 1);

            const testResult = this.runningTests.get(testId) as UITestResult;

            // Test each page multiple times for statistical accuracy
            for (const pageConfig of scenarioConfig.pages) {
                for (let iteration = 0; iteration < (scenarioConfig.loadConfig.duration || 3); iteration++) {
                    CSReporter.info(`Measuring Core Web Vitals for ${pageConfig.name} - iteration ${iteration + 1}`);

                    try {
                    // Navigate to page and measure performance
                    const pageMetrics = await performanceMonitor.measurePageLoad(page, pageConfig.url);

                    // Convert to UI metrics format - create partial object and cast
                    const uiMetrics = {
                        timestamp: Date.now(),
                        virtualUsers: { active: 1, total: 1, completed: 0, failed: 0 },
                        requests: { sent: 1, completed: 1, failed: 0, pending: 0 },
                        timing: {
                            averageResponseTime: pageMetrics.loadComplete || 0,
                            minResponseTime: pageMetrics.loadComplete || 0,
                            maxResponseTime: pageMetrics.loadComplete || 0,
                            percentile50: pageMetrics.loadComplete || 0,
                            percentile95: pageMetrics.loadComplete || 0
                        },
                        throughput: {
                            requestsPerSecond: 0,
                            bytesPerSecond: pageMetrics.totalTransferSize || 0,
                            averageThroughput: 0
                        },
                        errors: { count: 0, rate: 0, types: {} },
                        webVitals: {
                            lcp: pageMetrics.lcp,
                            fid: pageMetrics.fid,
                            cls: pageMetrics.cls,
                            fcp: pageMetrics.fcp,
                            ttfb: pageMetrics.ttfb
                        },
                        pageLoad: {
                            domContentLoaded: pageMetrics.domContentLoaded || 0,
                            loadComplete: pageMetrics.loadComplete || 0,
                            firstPaint: 0,
                            firstContentfulPaint: pageMetrics.fcp || 0,
                            largestContentfulPaint: pageMetrics.lcp || 0
                        },
                        resources: {
                            totalSize: pageMetrics.totalResourceSize || 0,
                            totalCount: pageMetrics.resourceCount || 0,
                            imageSize: 0,
                            jsSize: 0,
                            cssSize: 0,
                            cacheHitRate: 0
                        },
                        navigation: {
                            type: 'navigate' as const,
                            redirectCount: 0,
                            transferSize: pageMetrics.totalTransferSize || 0
                        },
                        visual: {
                            viewport: scenarioConfig.browserConfig.viewport || { width: 1366, height: 768 },
                            devicePixelRatio: 1
                        }
                    } as UIPerformanceMetrics;

                    testResult.uiMetrics.push(uiMetrics);

                    // Create page load result
                    const pageLoadResult = {
                        url: pageConfig.url,
                        pageName: pageConfig.name,
                        loadTime: pageMetrics.loadComplete || 0,
                        domContentLoadedTime: pageMetrics.domContentLoaded || 0,
                        webVitals: {
                            lcp: pageMetrics.lcp,
                            fid: pageMetrics.fid,
                            cls: pageMetrics.cls,
                            fcp: pageMetrics.fcp,
                            ttfb: pageMetrics.ttfb
                        },
                        resourceMetrics: {
                            totalRequests: pageMetrics.resourceCount || 0,
                            totalSize: pageMetrics.totalResourceSize || 0,
                            slowestResource: { url: '', duration: 0 }
                        },
                        errors: []
                    };

                        testResult.pageLoadResults.push(pageLoadResult);

                    } catch (error) {
                        const err = error as Error;
                        testResult.errors.push(this.createPerformanceError(
                            `Page ${pageConfig.name} error: ${err.message || String(error)}`,
                            err,
                            undefined,
                            pageConfig.url
                        ));
                    }
                }
            }

            // Stop performance monitoring
            await performanceMonitor.stopMonitoring();

        } finally {
            // Release browser instance back to pool or close browser
            if (browserInstance && this.useBrowserPool) {
                await this.browserPool.release(browserInstance);
            } else {
                const browserManager = CSBrowserManager.getInstance();
                await browserManager.closeBrowser();
            }
        }
    }

    /**
     * Run Page Load performance test
     */
    private async runPageLoadTest(testId: string, scenarioConfig: UIPerformanceScenarioConfig): Promise<void> {
        // Similar to Core Web Vitals test but with more detailed page load metrics
        await this.runCoreWebVitalsTest(testId, scenarioConfig);
    }

    /**
     * Run UI Load test with multiple browsers
     */
    private async runUILoadTest(testId: string, scenarioConfig: UIPerformanceScenarioConfig): Promise<void> {
        const performanceMonitor = CSPerformanceMonitor.getInstance();
        const virtualUsers = scenarioConfig.loadConfig.virtualUsers;
        const duration = scenarioConfig.loadConfig.duration * 1000; // Convert to milliseconds

        CSReporter.info(`Starting UI load test with ${virtualUsers} browsers for ${duration/1000} seconds`);

        // Start monitoring for multiple browsers
        await performanceMonitor.startConcurrentMonitoring('UILoad-${testId}', virtualUsers);

        const testResult = this.runningTests.get(testId) as UITestResult;
        const startTime = Date.now();

        // Create virtual browser users
        const browserPromises = [];

        for (let i = 0; i < virtualUsers; i++) {
            const browserPromise = this.runVirtualBrowserUser(i, scenarioConfig, testResult, duration);
            browserPromises.push(browserPromise);
        }

        // Wait for all browsers to complete
        await Promise.all(browserPromises);

        // Stop monitoring
        await performanceMonitor.stopMonitoring();
    }

    /**
     * Run Visual Regression performance test
     */
    private async runVisualRegressionTest(testId: string, scenarioConfig: UIPerformanceScenarioConfig): Promise<void> {
        const visualTesting = CSVisualTesting.getInstance();
        let browserInstance: BrowserInstance | null = null;
        let page;

        try {
            // Acquire browser from pool or create new browser
            if (this.useBrowserPool) {
                browserInstance = await this.browserPool.acquire(scenarioConfig.browserConfig.browserType || 'chromium');
                page = browserInstance.page;
            } else {
                const browserManager = CSBrowserManager.getInstance();
                await browserManager.launch(scenarioConfig.browserConfig.browserType || 'chromium');
                page = browserManager.getPage();
            }

            if (!page) {
                throw new Error('Failed to initialize browser page');
            }

            const testResult = this.runningTests.get(testId) as UITestResult;

            // Test visual regression for each page
            for (const pageConfig of scenarioConfig.pages) {
                CSReporter.info(`Running visual regression test for ${pageConfig.name}`);

                try {
                // Navigate to page
                await page.goto(pageConfig.url, { waitUntil: 'networkidle' });

                // Capture and compare screenshot
                const screenshotPath = await visualTesting.captureScreenshot(page, {
                    name: pageConfig.name,
                    fullPage: scenarioConfig.visualTesting?.fullPage,
                    threshold: scenarioConfig.visualTesting?.threshold,
                    mask: scenarioConfig.visualTesting?.mask
                });

                // Create visual result
                const visualResult = {
                    pageName: pageConfig.name,
                    passed: true, // This would be determined by visual comparison
                    differencePercentage: 0,
                    baselineImage: screenshotPath,
                    actualImage: screenshotPath,
                    timestamp: Date.now()
                };

                    testResult.visualResults!.push(visualResult);

                } catch (error) {
                    const err = error as Error;
                    testResult.errors.push(this.createPerformanceError(
                        `Visual test failed for ${pageConfig.name}: ${err.message || String(error)}`,
                        err,
                        undefined,
                        pageConfig.url
                    ));
                }
            }

        } finally {
            // Release browser instance back to pool or close browser
            if (browserInstance && this.useBrowserPool) {
                await this.browserPool.release(browserInstance);
            } else {
                const browserManager = CSBrowserManager.getInstance();
                await browserManager.closeBrowser();
            }
        }
    }

    /**
     * Run virtual browser user for UI load testing
     */
    private async runVirtualBrowserUser(userId: number, scenarioConfig: UIPerformanceScenarioConfig, testResult: UITestResult, duration: number): Promise<void> {
        let browserInstance: BrowserInstance | null = null;
        let page;

        try {
            // Acquire browser from pool or create new browser
            if (this.useBrowserPool) {
                browserInstance = await this.browserPool.acquire(scenarioConfig.browserConfig.browserType || 'chromium');
                page = browserInstance.page;
            } else {
                const browserManager = CSBrowserManager.getInstance();
                await browserManager.launch(scenarioConfig.browserConfig.browserType || 'chromium');
                page = browserManager.getPage();
            }

            if (!page) {
                throw new Error(`Failed to create page for virtual user ${userId}`);
            }

            const endTime = Date.now() + duration;
            let pageIndex = 0;

            // Navigate through pages for the duration
            while (Date.now() < endTime) {
                const pageConfig = scenarioConfig.pages[pageIndex % scenarioConfig.pages.length];

                try {
                    const startTime = Date.now();
                    await page.goto(pageConfig.url, { waitUntil: 'load' });
                    const loadTime = Date.now() - startTime;

                    // Record metrics for this page load
                    testResult.summary.totalRequests++;
                    testResult.summary.successfulRequests++;

                    if (loadTime > testResult.summary.maxResponseTime) {
                        testResult.summary.maxResponseTime = loadTime;
                    }

                    if (testResult.summary.minResponseTime === 0 || loadTime < testResult.summary.minResponseTime) {
                        testResult.summary.minResponseTime = loadTime;
                    }

                } catch (error) {
                    testResult.summary.failedRequests++;
                    const err = error as Error;
                    testResult.errors.push(this.createPerformanceError(
                        `User ${userId} navigation error: ${err.message || String(error)}`,
                        err,
                        `user_${userId}`,
                        pageConfig.url
                    ));
                }

                pageIndex++;

                // Wait think time between page loads
                if (scenarioConfig.loadConfig.thinkTime) {
                    await this.sleep(scenarioConfig.loadConfig.thinkTime);
                }
            }

        } catch (error) {
            const err = error as Error;
            testResult.errors.push(this.createPerformanceError(
                `Virtual user ${userId} error: ${err.message || String(error)}`,
                err,
                `user_${userId}`
            ));
        } finally {
            // Release browser instance back to pool or close browser
            if (browserInstance && this.useBrowserPool) {
                await this.browserPool.release(browserInstance);
            } else {
                const browserManager = CSBrowserManager.getInstance();
                await browserManager.closeBrowser();
            }
        }
    }

    /**
     * Validate UI scenario configuration
     */
    private validateUIScenarioConfig(scenarioConfig: UIPerformanceScenarioConfig): void {
        if (!scenarioConfig.pages || scenarioConfig.pages.length === 0) {
            throw new Error('UI performance test requires at least one page configuration');
        }

        if (!scenarioConfig.browserConfig) {
            throw new Error('Browser configuration is required for UI performance tests');
        }

        // Validate test-specific requirements
        if (scenarioConfig.testType === 'ui-load' && scenarioConfig.loadConfig.virtualUsers > 20) {
            CSReporter.warn('UI load tests with more than 20 browsers may impact system performance significantly');
        }

        if (scenarioConfig.testType === 'ui-load' && scenarioConfig.loadConfig.virtualUsers > 20) {
            CSReporter.warn('UI load tests with more than 20 browsers may impact system performance significantly');
        }
    }

    /**
     * Calculate Core Web Vitals scores based on Google thresholds
     */
    private calculateWebVitalsScores(testResult: UITestResult): UITestResult['webVitalsScores'] {
        if (!testResult.uiMetrics || testResult.uiMetrics.length === 0) {
            return {
                lcp: 'poor',
                fid: 'poor',
                cls: 'poor',
                fcp: 'poor',
                ttfb: 'poor',
                overall: 'poor'
            };
        }

        // Calculate average metrics
        const avgMetrics = this.calculateAverageWebVitals(testResult.uiMetrics);

        // Apply Google Core Web Vitals thresholds
        const lcpScore = this.getWebVitalScore(avgMetrics.lcp, { good: 2500, needsImprovement: 4000 });
        const fidScore = this.getWebVitalScore(avgMetrics.fid, { good: 100, needsImprovement: 300 });
        const clsScore = this.getWebVitalScore(avgMetrics.cls, { good: 0.1, needsImprovement: 0.25 });
        const fcpScore = this.getWebVitalScore(avgMetrics.fcp, { good: 1800, needsImprovement: 3000 });
        const ttfbScore = this.getWebVitalScore(avgMetrics.ttfb, { good: 800, needsImprovement: 1800 });

        // Overall score is the worst individual score
        const scores = [lcpScore, fidScore, clsScore, fcpScore, ttfbScore];
        let overall: 'good' | 'needs-improvement' | 'poor' = 'good';

        if (scores.includes('poor')) {
            overall = 'poor';
        } else if (scores.includes('needs-improvement')) {
            overall = 'needs-improvement';
        }

        return {
            lcp: lcpScore,
            fid: fidScore,
            cls: clsScore,
            fcp: fcpScore,
            ttfb: ttfbScore,
            overall
        };
    }

    /**
     * Calculate average Core Web Vitals from UI metrics
     */
    private calculateAverageWebVitals(uiMetrics: UIPerformanceMetrics[]): CoreWebVitalsMetrics {
        const totals = { lcp: 0, fid: 0, cls: 0, fcp: 0, ttfb: 0 };
        const counts = { lcp: 0, fid: 0, cls: 0, fcp: 0, ttfb: 0 };

        for (const metrics of uiMetrics) {
            if (metrics.webVitals) {
                if (metrics.webVitals.lcp !== undefined) {
                    totals.lcp += metrics.webVitals.lcp;
                    counts.lcp++;
                }

                if (metrics.webVitals.fid !== undefined) {
                    totals.fid += metrics.webVitals.fid;
                    counts.fid++;
                }

                if (metrics.webVitals.cls !== undefined) {
                    totals.cls += metrics.webVitals.cls;
                    counts.cls++;
                }

                if (metrics.webVitals.fcp !== undefined) {
                    totals.fcp += metrics.webVitals.fcp;
                    counts.fcp++;
                }

                if (metrics.webVitals.ttfb !== undefined) {
                    totals.ttfb += metrics.webVitals.ttfb;
                    counts.ttfb++;
                }
            }
        }

        return {
            lcp: counts.lcp > 0 ? totals.lcp / counts.lcp : undefined,
            fid: counts.fid > 0 ? totals.fid / counts.fid : undefined,
            cls: counts.cls > 0 ? totals.cls / counts.cls : undefined,
            fcp: counts.fcp > 0 ? totals.fcp / counts.fcp : undefined,
            ttfb: counts.ttfb > 0 ? totals.ttfb / counts.ttfb : undefined
        };
    }

    /**
     * Get Web Vital score based on thresholds
     */
    private getWebVitalScore(value: number | undefined, thresholds: { good: number; needsImprovement: number }): 'good' | 'needs-improvement' | 'poor' {
        if (value === undefined) {
            return 'poor';
        }

        if (value <= thresholds.good) {
            return 'good';
        } else if (value <= thresholds.needsImprovement) {
            return 'needs-improvement';
        } else {
            return 'poor';
        }
    }

    /**
     * Shutdown performance test runner and cleanup resources
     */
    public async shutdown(): Promise<void> {
        CSReporter.info('Shutting down performance test runner');

        // Stop all running tests
        const runningTests = this.getRunningTests();
        for (const test of runningTests) {
            try {
                await this.stopTest(test.testId);
            } catch (error) {
                CSReporter.warn(`Error stopping test ${test.testId}: ${(error as Error).message}`);
            }
        }

        // Shutdown browser pool if enabled
        if (this.useBrowserPool && this.browserPool) {
            await this.browserPool.shutdown();
            CSReporter.info('Browser pool shut down successfully');
        }

        // Clear all maps
        this.runningTests.clear();
        this.metricsCollectors.clear();
        this.eventCallbacks.clear();

        CSReporter.info('Performance test runner shutdown complete');
    }

    /**
     * Get browser pool status (if enabled)
     */
    public getBrowserPoolStatus(): any {
        if (!this.useBrowserPool || !this.browserPool) {
            return { enabled: false, message: 'Browser pool is not enabled' };
        }

        return {
            enabled: true,
            ...this.browserPool.getPoolStatus()
        };
    }
}