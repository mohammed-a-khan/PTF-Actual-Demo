import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import { CSReporter } from '../../reporter/CSReporter';
import {
    PerformanceScenarioConfig,
    PerformanceTestType,
    LoadConfiguration,
    LoadPattern,
    PerformanceThresholds,
    RequestTemplate,
    AuthConfig,
    DataSourceConfig
} from '../types/CSPerformanceTypes';

/**
 * Base Performance Scenario
 * Abstract base class for all performance testing scenarios
 */
export abstract class CSPerformanceScenario {
    protected config: CSConfigurationManager;
    protected scenarioConfig: PerformanceScenarioConfig;

    constructor(scenarioConfig: PerformanceScenarioConfig) {
        this.config = CSConfigurationManager.getInstance();
        this.scenarioConfig = scenarioConfig;
        this.validateConfiguration();
    }

    protected abstract validateConfiguration(): void;

    public getConfiguration(): PerformanceScenarioConfig {
        return this.scenarioConfig;
    }

    public updateConfiguration(updates: Partial<PerformanceScenarioConfig>): void {
        this.scenarioConfig = { ...this.scenarioConfig, ...updates };
        this.validateConfiguration();
    }
}

/**
 * Load Test Scenario
 * Maintains constant load for sustained period to test normal operating conditions
 */
export class CSLoadTestScenario extends CSPerformanceScenario {
    
    protected validateConfiguration(): void {
        if (this.scenarioConfig.testType !== 'load') {
            throw new Error('Scenario must be of type "load"');
        }

        if (this.scenarioConfig.loadConfig.pattern !== 'constant') {
            CSReporter.warn('Load test typically uses constant pattern, consider changing pattern');
        }

        if (this.scenarioConfig.loadConfig.virtualUsers < 1) {
            throw new Error('Virtual users must be at least 1');
        }

        if (this.scenarioConfig.loadConfig.duration < 60) {
            CSReporter.warn('Load tests are typically run for at least 60 seconds');
        }
    }

    /**
     * Create a standard load test scenario
     */
    static createStandardLoadTest(options: {
        name: string;
        virtualUsers: number;
        duration: number;
        targetUrl: string;
        thinkTime?: number;
        requestTemplate?: RequestTemplate;
    }): CSLoadTestScenario {
        
        const scenarioConfig: PerformanceScenarioConfig = {
            id: `load_test_${Date.now()}`,
            name: options.name,
            description: `Load test with ${options.virtualUsers} users for ${options.duration}s`,
            testType: 'load',
            loadConfig: {
                pattern: 'constant',
                virtualUsers: options.virtualUsers,
                duration: options.duration,
                thinkTime: options.thinkTime || 1000
            },
            thresholds: {
                responseTime: {
                    average: 2000,
                    percentile95: 5000,
                    maximum: 10000
                },
                errorRate: {
                    maximum: 1 // 1%
                },
                throughput: {
                    minimum: options.virtualUsers * 0.8 // 80% of expected
                }
            },
            targetEndpoint: options.targetUrl,
            requestTemplate: options.requestTemplate,
            warmupRequests: Math.min(options.virtualUsers, 10),
            tags: ['load-test', 'baseline']
        };

        return new CSLoadTestScenario(scenarioConfig);
    }

    /**
     * Create a ramp-up load test scenario
     */
    static createRampUpLoadTest(options: {
        name: string;
        maxUsers: number;
        rampUpTime: number;
        sustainTime: number;
        targetUrl: string;
        requestTemplate?: RequestTemplate;
    }): CSLoadTestScenario {
        
        const totalDuration = options.rampUpTime + options.sustainTime;

        const scenarioConfig: PerformanceScenarioConfig = {
            id: `ramp_load_test_${Date.now()}`,
            name: options.name,
            description: `Ramp-up load test to ${options.maxUsers} users over ${options.rampUpTime}s, sustain for ${options.sustainTime}s`,
            testType: 'load',
            loadConfig: {
                pattern: 'ramp-up',
                virtualUsers: options.maxUsers,
                duration: totalDuration,
                rampUpTime: options.rampUpTime,
                thinkTime: 1000
            },
            thresholds: {
                responseTime: {
                    average: 2500,
                    percentile95: 6000
                },
                errorRate: {
                    maximum: 2 // 2% during ramp-up
                }
            },
            targetEndpoint: options.targetUrl,
            requestTemplate: options.requestTemplate,
            warmupRequests: 5,
            tags: ['load-test', 'ramp-up']
        };

        return new CSLoadTestScenario(scenarioConfig);
    }
}

/**
 * Stress Test Scenario
 * Gradually increases load beyond normal capacity to find breaking point
 */
export class CSStressTestScenario extends CSPerformanceScenario {
    
    protected validateConfiguration(): void {
        if (this.scenarioConfig.testType !== 'stress') {
            throw new Error('Scenario must be of type "stress"');
        }

        if (!(['step', 'ramp-up', 'custom'].includes(this.scenarioConfig.loadConfig.pattern))) {
            throw new Error('Stress tests require step, ramp-up, or custom load pattern');
        }

        if (this.scenarioConfig.loadConfig.virtualUsers < 10) {
            CSReporter.warn('Stress tests typically use higher user counts to find limits');
        }
    }

    /**
     * Create a standard stress test scenario
     */
    static createStandardStressTest(options: {
        name: string;
        startUsers: number;
        maxUsers: number;
        stepDuration: number;
        targetUrl: string;
        requestTemplate?: RequestTemplate;
    }): CSStressTestScenario {
        
        const steps = Math.ceil((options.maxUsers - options.startUsers) / Math.max(1, Math.floor(options.maxUsers / 10)));
        const totalDuration = steps * options.stepDuration;

        const scenarioConfig: PerformanceScenarioConfig = {
            id: `stress_test_${Date.now()}`,
            name: options.name,
            description: `Stress test from ${options.startUsers} to ${options.maxUsers} users in ${steps} steps`,
            testType: 'stress',
            loadConfig: {
                pattern: 'step',
                virtualUsers: options.maxUsers,
                duration: totalDuration
            },
            thresholds: {
                responseTime: {
                    average: 5000, // Higher tolerance for stress tests
                    percentile95: 15000,
                    maximum: 30000
                },
                errorRate: {
                    maximum: 10 // 10% acceptable during stress
                },
                systemResources: {
                    cpuUsage: 90,
                    memoryUsage: 85
                }
            },
            targetEndpoint: options.targetUrl,
            requestTemplate: options.requestTemplate,
            warmupRequests: 5,
            tags: ['stress-test', 'breaking-point']
        };

        return new CSStressTestScenario(scenarioConfig);
    }

    /**
     * Create a custom step stress test
     */
    static createCustomStepStressTest(options: {
        name: string;
        userSteps: Array<{ users: number; duration: number; description?: string }>;
        targetUrl: string;
        requestTemplate?: RequestTemplate;
    }): CSStressTestScenario {
        
        const maxUsers = Math.max(...options.userSteps.map(step => step.users));
        const totalDuration = options.userSteps.reduce((sum, step) => sum + step.duration, 0);

        const customPattern = options.userSteps.map((step, index) => ({
            timestamp: options.userSteps.slice(0, index).reduce((sum, s) => sum + s.duration, 0),
            virtualUsers: step.users,
            duration: step.duration,
            description: step.description || `Step ${index + 1}: ${step.users} users`
        }));

        const scenarioConfig: PerformanceScenarioConfig = {
            id: `custom_stress_test_${Date.now()}`,
            name: options.name,
            description: `Custom stress test with ${options.userSteps.length} steps over ${totalDuration}s`,
            testType: 'stress',
            loadConfig: {
                pattern: 'custom',
                virtualUsers: maxUsers,
                duration: totalDuration,
                customPattern
            },
            thresholds: {
                responseTime: {
                    average: 4000,
                    percentile95: 12000
                },
                errorRate: {
                    maximum: 8
                }
            },
            targetEndpoint: options.targetUrl,
            requestTemplate: options.requestTemplate,
            tags: ['stress-test', 'custom-pattern']
        };

        return new CSStressTestScenario(scenarioConfig);
    }
}

/**
 * Spike Test Scenario
 * Tests system behavior under sudden load spikes
 */
export class CSSpikeTestScenario extends CSPerformanceScenario {
    
    protected validateConfiguration(): void {
        if (this.scenarioConfig.testType !== 'spike') {
            throw new Error('Scenario must be of type "spike"');
        }

        if (this.scenarioConfig.loadConfig.pattern !== 'spike') {
            throw new Error('Spike tests must use spike load pattern');
        }
    }

    /**
     * Create a standard spike test scenario
     */
    static createStandardSpikeTest(options: {
        name: string;
        baselineUsers: number;
        spikeUsers: number;
        spikeDuration: number;
        totalDuration: number;
        targetUrl: string;
        requestTemplate?: RequestTemplate;
    }): CSSpikeTestScenario {
        
        const scenarioConfig: PerformanceScenarioConfig = {
            id: `spike_test_${Date.now()}`,
            name: options.name,
            description: `Spike test: ${options.baselineUsers} baseline → ${options.spikeUsers} spike for ${options.spikeDuration}s`,
            testType: 'spike',
            loadConfig: {
                pattern: 'spike',
                virtualUsers: options.spikeUsers,
                duration: options.totalDuration
            },
            thresholds: {
                responseTime: {
                    average: 3000,
                    percentile95: 8000,
                    maximum: 20000
                },
                errorRate: {
                    maximum: 5 // 5% during spike acceptable
                },
                systemResources: {
                    cpuUsage: 95,
                    memoryUsage: 90
                }
            },
            targetEndpoint: options.targetUrl,
            requestTemplate: options.requestTemplate,
            warmupRequests: Math.min(options.baselineUsers, 5),
            tags: ['spike-test', 'sudden-load']
        };

        return new CSSpikeTestScenario(scenarioConfig);
    }

    /**
     * Create a multiple spike test scenario
     */
    static createMultipleSpikeTest(options: {
        name: string;
        baselineUsers: number;
        spikes: Array<{ users: number; duration: number; pauseDuration: number }>;
        targetUrl: string;
        requestTemplate?: RequestTemplate;
    }): CSSpikeTestScenario {
        
        const maxUsers = Math.max(...options.spikes.map(spike => spike.users));
        const totalDuration = options.spikes.reduce((sum, spike) => sum + spike.duration + spike.pauseDuration, 0);

        // Create custom pattern for multiple spikes
        const customPattern = [];
        let currentTime = 0;

        for (const spike of options.spikes) {
            // Baseline period
            customPattern.push({
                timestamp: currentTime,
                virtualUsers: options.baselineUsers,
                duration: 30, // 30s baseline
                description: `Baseline: ${options.baselineUsers} users`
            });
            currentTime += 30;

            // Spike period
            customPattern.push({
                timestamp: currentTime,
                virtualUsers: spike.users,
                duration: spike.duration,
                description: `Spike: ${spike.users} users`
            });
            currentTime += spike.duration;

            // Recovery period
            customPattern.push({
                timestamp: currentTime,
                virtualUsers: options.baselineUsers,
                duration: spike.pauseDuration,
                description: `Recovery: ${options.baselineUsers} users`
            });
            currentTime += spike.pauseDuration;
        }

        const scenarioConfig: PerformanceScenarioConfig = {
            id: `multi_spike_test_${Date.now()}`,
            name: options.name,
            description: `Multiple spike test with ${options.spikes.length} spikes`,
            testType: 'spike',
            loadConfig: {
                pattern: 'custom',
                virtualUsers: maxUsers,
                duration: totalDuration,
                customPattern
            },
            thresholds: {
                responseTime: {
                    average: 3500,
                    percentile95: 10000
                },
                errorRate: {
                    maximum: 7
                }
            },
            targetEndpoint: options.targetUrl,
            requestTemplate: options.requestTemplate,
            tags: ['spike-test', 'multiple-spikes']
        };

        return new CSSpikeTestScenario(scenarioConfig);
    }
}

/**
 * Volume Test Scenario
 * Tests system behavior with large amounts of data
 */
export class CSVolumeTestScenario extends CSPerformanceScenario {
    
    protected validateConfiguration(): void {
        if (this.scenarioConfig.testType !== 'volume') {
            throw new Error('Scenario must be of type "volume"');
        }

        if (!this.scenarioConfig.dataSource) {
            CSReporter.warn('Volume tests typically require large datasets');
        }
    }

    /**
     * Create a data volume test scenario
     */
    static createDataVolumeTest(options: {
        name: string;
        virtualUsers: number;
        duration: number;
        dataSource: DataSourceConfig;
        targetUrl: string;
        requestTemplate?: RequestTemplate;
    }): CSVolumeTestScenario {
        
        const scenarioConfig: PerformanceScenarioConfig = {
            id: `volume_test_${Date.now()}`,
            name: options.name,
            description: `Volume test with large dataset processing`,
            testType: 'volume',
            loadConfig: {
                pattern: 'constant',
                virtualUsers: options.virtualUsers,
                duration: options.duration,
                thinkTime: 500 // Faster execution for volume
            },
            thresholds: {
                responseTime: {
                    average: 4000,
                    percentile95: 12000
                },
                errorRate: {
                    maximum: 3
                },
                systemResources: {
                    memoryUsage: 80 // Important for volume tests
                }
            },
            targetEndpoint: options.targetUrl,
            requestTemplate: options.requestTemplate,
            dataSource: options.dataSource,
            tags: ['volume-test', 'data-intensive']
        };

        return new CSVolumeTestScenario(scenarioConfig);
    }
}

/**
 * Endurance Test Scenario
 * Long-running test to identify memory leaks and performance degradation
 */
export class CSEnduranceTestScenario extends CSPerformanceScenario {
    
    protected validateConfiguration(): void {
        if (this.scenarioConfig.testType !== 'endurance') {
            throw new Error('Scenario must be of type "endurance"');
        }

        if (this.scenarioConfig.loadConfig.duration < 3600) { // 1 hour
            CSReporter.warn('Endurance tests are typically run for at least 1 hour');
        }
    }

    /**
     * Create a standard endurance test scenario
     */
    static createStandardEnduranceTest(options: {
        name: string;
        virtualUsers: number;
        durationHours: number;
        targetUrl: string;
        requestTemplate?: RequestTemplate;
    }): CSEnduranceTestScenario {
        
        const scenarioConfig: PerformanceScenarioConfig = {
            id: `endurance_test_${Date.now()}`,
            name: options.name,
            description: `Endurance test with ${options.virtualUsers} users for ${options.durationHours} hours`,
            testType: 'endurance',
            loadConfig: {
                pattern: 'constant',
                virtualUsers: options.virtualUsers,
                duration: options.durationHours * 3600, // Convert to seconds
                thinkTime: 2000 // Slower pace for long tests
            },
            thresholds: {
                responseTime: {
                    average: 2500,
                    percentile95: 7000
                },
                errorRate: {
                    maximum: 0.5 // Strict for long tests
                },
                systemResources: {
                    cpuUsage: 70,
                    memoryUsage: 75 // Monitor memory leaks
                }
            },
            targetEndpoint: options.targetUrl,
            requestTemplate: options.requestTemplate,
            warmupRequests: 20,
            cooldownTime: 60000, // 1 minute cooldown
            tags: ['endurance-test', 'long-running', 'memory-leak-detection']
        };

        return new CSEnduranceTestScenario(scenarioConfig);
    }
}

/**
 * Baseline Test Scenario
 * Establishes performance baseline with minimal load
 */
export class CSBaselineTestScenario extends CSPerformanceScenario {
    
    protected validateConfiguration(): void {
        if (this.scenarioConfig.testType !== 'baseline') {
            throw new Error('Scenario must be of type "baseline"');
        }

        if (this.scenarioConfig.loadConfig.virtualUsers > 5) {
            CSReporter.warn('Baseline tests typically use minimal load (1-5 users)');
        }
    }

    /**
     * Create a baseline performance test
     */
    static createBaselineTest(options: {
        name: string;
        virtualUsers?: number;
        duration?: number;
        targetUrl: string;
        requestTemplate?: RequestTemplate;
    }): CSBaselineTestScenario {
        
        const scenarioConfig: PerformanceScenarioConfig = {
            id: `baseline_test_${Date.now()}`,
            name: options.name,
            description: `Baseline test to establish performance metrics`,
            testType: 'baseline',
            loadConfig: {
                pattern: 'constant',
                virtualUsers: options.virtualUsers || 1,
                duration: options.duration || 300, // 5 minutes default
                thinkTime: 3000
            },
            thresholds: {
                responseTime: {
                    average: 1000,
                    percentile95: 2500
                },
                errorRate: {
                    maximum: 0.1 // Very strict for baseline
                }
            },
            targetEndpoint: options.targetUrl,
            requestTemplate: options.requestTemplate,
            warmupRequests: 3,
            tags: ['baseline-test', 'performance-baseline']
        };

        return new CSBaselineTestScenario(scenarioConfig);
    }
}

// ===== UI Performance Scenarios =====

/**
 * Core Web Vitals Performance Scenario
 * Tests Core Web Vitals metrics (LCP, FID, CLS, FCP, TTFB) across multiple page loads
 */
export class CSCoreWebVitalsScenario extends CSPerformanceScenario {
    
    protected validateConfiguration(): void {
        if (this.scenarioConfig.testType !== 'core-web-vitals') {
            throw new Error('Scenario must be of type "core-web-vitals"');
        }

        const uiConfig = this.scenarioConfig as any;
        if (!uiConfig.pages || uiConfig.pages.length === 0) {
            throw new Error('Core Web Vitals test requires at least one page configuration');
        }

        if (!uiConfig.webVitalsThresholds) {
            CSReporter.warn('No Web Vitals thresholds specified, using Google recommendations');
        }
    }

    /**
     * Create a Core Web Vitals performance test scenario
     */
    static createCoreWebVitalsTest(options: {
        name: string;
        pages: string[];
        iterations?: number;
        browserType?: 'chromium' | 'firefox' | 'webkit';
        mobileEmulation?: string;
        webVitalsThresholds?: any;
    }): CSCoreWebVitalsScenario {
        
        const scenarioConfig: any = {
            id: `web_vitals_${Date.now()}`,
            name: options.name,
            description: `Core Web Vitals test for ${options.pages.length} page(s)`,
            testType: 'core-web-vitals',
            loadConfig: {
                pattern: 'constant',
                virtualUsers: 1,
                duration: options.iterations || 5,
                iterations: options.iterations || 5
            },
            thresholds: {
                responseTime: { average: 3000 },
                errorRate: { maximum: 0 }
            },
            browserConfig: {
                browserType: options.browserType || 'chromium',
                headless: true,
                deviceEmulation: options.mobileEmulation,
                recordTrace: true
            },
            pages: options.pages.map(url => ({
                url,
                name: new URL(url).pathname,
                waitConditions: ['load', 'networkidle']
            })),
            webVitalsThresholds: options.webVitalsThresholds || {
                lcp: { good: 2500, needsImprovement: 4000 },
                fid: { good: 100, needsImprovement: 300 },
                cls: { good: 0.1, needsImprovement: 0.25 },
                fcp: { good: 1800, needsImprovement: 3000 },
                ttfb: { good: 800, needsImprovement: 1800 }
            },
            tags: ['core-web-vitals', 'ui-performance']
        };

        return new CSCoreWebVitalsScenario(scenarioConfig);
    }
}

/**
 * Page Load Performance Scenario
 * Comprehensive page load performance testing with detailed metrics
 */
export class CSPageLoadPerformanceScenario extends CSPerformanceScenario {
    
    protected validateConfiguration(): void {
        if (this.scenarioConfig.testType !== 'page-load') {
            throw new Error('Scenario must be of type "page-load"');
        }

        const uiConfig = this.scenarioConfig as any;
        if (!uiConfig.pages || uiConfig.pages.length === 0) {
            throw new Error('Page load test requires at least one page configuration');
        }
    }

    /**
     * Create a page load performance test scenario
     */
    static createPageLoadTest(options: {
        name: string;
        pages: Array<{ url: string; name?: string; interactions?: any[] }>;
        browserType?: 'chromium' | 'firefox' | 'webkit';
        networkThrottling?: any;
        iterations?: number;
        cacheStrategy?: 'disabled' | 'enabled' | 'clear-between-tests';
    }): CSPageLoadPerformanceScenario {
        
        const scenarioConfig: any = {
            id: `page_load_${Date.now()}`,
            name: options.name,
            description: `Page load performance test for ${options.pages.length} page(s)`,
            testType: 'page-load',
            loadConfig: {
                pattern: 'constant',
                virtualUsers: 1,
                duration: options.iterations || 3,
                iterations: options.iterations || 3
            },
            thresholds: {
                responseTime: { average: 5000, percentile95: 8000 },
                errorRate: { maximum: 0 }
            },
            browserConfig: {
                browserType: options.browserType || 'chromium',
                headless: true,
                networkThrottling: options.networkThrottling,
                cacheStrategy: options.cacheStrategy || 'clear-between-tests',
                recordVideo: false,
                recordTrace: true
            },
            pages: options.pages.map(page => ({
                url: page.url,
                name: page.name || new URL(page.url).pathname,
                waitConditions: ['load', 'networkidle'],
                interactions: page.interactions || []
            })),
            tags: ['page-load', 'ui-performance']
        };

        return new CSPageLoadPerformanceScenario(scenarioConfig);
    }
}

/**
 * UI Load Test Scenario
 * Browser-based load testing with multiple virtual users navigating pages
 */
export class CSUILoadTestScenario extends CSPerformanceScenario {
    
    protected validateConfiguration(): void {
        if (this.scenarioConfig.testType !== 'ui-load') {
            throw new Error('Scenario must be of type "ui-load"');
        }

        const uiConfig = this.scenarioConfig as any;
        if (!uiConfig.pages || uiConfig.pages.length === 0) {
            throw new Error('UI load test requires at least one page configuration');
        }

        if (this.scenarioConfig.loadConfig.virtualUsers > 10) {
            CSReporter.warn('UI load tests with more than 10 concurrent browsers may impact system performance');
        }
    }
    /**
     * Create a UI load test scenario
     */
    static createUILoadTest(options: {
        name: string;
        pages: string[];
        virtualUsers: number;
        duration: number; // in seconds
        browserType?: 'chromium' | 'firefox' | 'webkit';
        userJourneys?: any[];
        thinkTime?: number;
    }): CSUILoadTestScenario {
        
        const scenarioConfig: any = {
            id: `ui_load_${Date.now()}`,
            name: options.name,
            description: `UI load test with ${options.virtualUsers} browsers for ${options.duration}s`,
            testType: 'ui-load',
            loadConfig: {
                pattern: 'constant',
                virtualUsers: options.virtualUsers,
                duration: options.duration,
                thinkTime: options.thinkTime || 2000
            },
            thresholds: {
                responseTime: {
                    average: 3000,
                    percentile95: 6000
                },
                errorRate: { maximum: 2 } // 2% for UI load tests
            },
            browserConfig: {
                browserType: options.browserType || 'chromium',
                headless: true,
                viewport: { width: 1366, height: 768 }
            },
            pages: options.pages.map(url => ({
                url,
                name: new URL(url).pathname,
                waitConditions: ['load']
            })),
            userJourneys: options.userJourneys || [],
            tags: ['ui-load', 'browser-load', 'ui-performance']
        };

        return new CSUILoadTestScenario(scenarioConfig);
    }
}

/**
 * Visual Regression Performance Scenario
 * Combines visual testing with performance measurement
 */
export class CSVisualRegressionPerformanceScenario extends CSPerformanceScenario {
    
    protected validateConfiguration(): void {
        if (this.scenarioConfig.testType !== 'visual-regression') {
            throw new Error('Scenario must be of type "visual-regression"');
        }

        const uiConfig = this.scenarioConfig as any;
        if (!uiConfig.pages || uiConfig.pages.length === 0) {
            throw new Error('Visual regression test requires at least one page configuration');
        }

        if (!uiConfig.visualTesting || !uiConfig.visualTesting.enabled) {
            throw new Error('Visual regression test requires visual testing configuration');
        }
    }

    /**
     * Create a visual regression performance test scenario
     */
    static createVisualRegressionTest(options: {
        name: string;
        pages: string[];
        visualThreshold?: number;
        browserType?: 'chromium' | 'firefox' | 'webkit';
        fullPage?: boolean;
        maskSelectors?: string[];
    }): CSVisualRegressionPerformanceScenario {
        
        const scenarioConfig: any = {
            id: `visual_regression_${Date.now()}`,
            name: options.name,
            description: `Visual regression performance test for ${options.pages.length} page(s)`,
            testType: 'visual-regression',
            loadConfig: {
                pattern: 'constant',
                virtualUsers: 1,
                duration: 1,
                iterations: 1
            },
            thresholds: {
                responseTime: { average: 5000 },
                errorRate: { maximum: 0 }
            },
            browserConfig: {
                browserType: options.browserType || 'chromium',
                headless: true,
                viewport: { width: 1280, height: 720 }
            },
            pages: options.pages.map(url => ({
                url,
                name: new URL(url).pathname,
                waitConditions: ['load', 'networkidle']
            })),
            visualTesting: {
                enabled: true,
                threshold: options.visualThreshold || 0.1,
                fullPage: options.fullPage !== false,
                mask: options.maskSelectors || [],
                animations: 'disabled' as const
            },
            tags: ['visual-regression', 'ui-performance']
        };

        return new CSVisualRegressionPerformanceScenario(scenarioConfig);
    }
}