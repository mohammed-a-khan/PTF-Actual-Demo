/**
 * CS Performance Testing Types
 * Comprehensive type definitions for performance testing scenarios, metrics, and configurations
 */

export type PerformanceTestType = 'load' | 'stress' | 'spike' | 'volume' | 'endurance' | 'baseline' | 'ui-load' | 'ui-stress' | 'core-web-vitals' | 'page-load' | 'visual-regression';

export type LoadPattern = 'constant' | 'ramp-up' | 'ramp-down' | 'step' | 'spike' | 'custom';

export type MetricType = 'response_time' | 'throughput' | 'error_rate' | 'cpu_usage' | 'memory_usage' | 'network_io' | 'icp' | 'fid' | 'cls' | 'fcp' | 'ttfb' | 'custom';

export interface VirtualUser {
    id: string;
    startTime: number;
    endTime?: number;
    requestCount: number;
    errorCount: number;
    averageResponseTime: number;
    status: 'active' | 'completed' | 'failed' | 'stopping';
}

export interface LoadConfiguration {
    pattern: LoadPattern;
    virtualUsers: number;
    duration: number; // in seconds
    rampUpTime?: number; // in seconds
    rampDownTime?: number; // in seconds
    thinkTime?: number; // in milliseconds
    iterations?: number;
    customPattern?: LoadStep[];
}

export interface LoadStep {
    timestamp: number; // relative to test start
    virtualUsers: number;
    duration: number;
    description?: string;
}

export interface PerformanceThresholds {
    responseTime?: {
        average?: number;
        percentile95?: number;
        percentile99?: number;
        maximum?: number;
    };
    throughput?: {
        minimum?: number; // requests per second
        average?: number;
    };
    errorRate?: {
        maximum?: number; // percentage
    };
    systemResources?: {
        cpuUsage?: number; // percentage
        memoryUsage?: number; // percentage
        networkIO?: number; // bytes per second
    };
    custom?: Record<string, number>;
}

export interface PerformanceScenarioConfig {
    id: string;
    name: string;
    description?: string;
    testType: PerformanceTestType;
    loadConfig: LoadConfiguration;
    thresholds: PerformanceThresholds;
    targetEndpoint?: string;
    requestTemplate?: RequestTemplate;
    dataSource?: DataSourceConfig;
    warmupRequests?: number;
    cooldownTime?: number;
    tags?: string[];
    environment?: string;
}

export interface RequestTemplate {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
    url: string;
    headers?: Record<string, string>;
    body?: any;
    authentication?: AuthConfig;
    timeout?: number;
    followRedirects?: boolean;
}

export interface AuthConfig {
    type: 'none' | 'basic' | 'bearer' | 'oauth2' | 'api-key' | 'custom';
    credentials?: {
        username?: string;
        password?: string;
        token?: string;
        apiKey?: string;
        customHeaders?: Record<string, string>;
    };
}

export interface DataSourceConfig {
    type: 'csv' | 'json' | 'database' | 'generator' | 'static';
    source: string;
    randomize?: boolean;
    limit?: boolean;
    parameters?: Record<string, any>;
}

export interface PerformanceMetrics {
    timestamp: number;
    virtualUsers: {
        active: number;
        total: number;
        completed: number;
        failed: number;
    };
    requests: {
        sent: number;
        completed: number;
        failed: number;
        pending: number;
    };
    timing: {
        averageResponseTime: number;
        minResponseTime: number;
        maxResponseTime: number;
        percentile50: number;
        percentile95: number;
        percentile99: number;
    };
    throughput: {
        requestsPerSecond: number;
        bytesPerSecond: number;
        averageThroughput: number;
    };
    errors: {
        count: number;
        rate: number; // percentage
        types: Record<string, number>;
    };
    system?: SystemMetrics;
    custom?: Record<string, number>;
}

export interface SystemMetrics {
    cpu: {
        usage: number; // percentage
        cores: number;
    };
    memory: {
        used: number; // bytes
        total: number; // bytes
        usage: number; // percentage
    };
    network: {
        bytesIn: number;
        bytesOut: number;
        packetsIn: number;
        packetsOut: number;
    };
    disk?: {
        readBytes: number;
        writeBytes: number;
        usage: number; // percentage
    };
}

export interface PerformanceTestResult {
    testId: string;
    scenarioId: string;
    scenarioName: string;
    startTime: number;
    endTime: number;
    duration: number;
    status: 'running' | 'completed' | 'failed' | 'stopped' | 'timeout';
    summary: PerformanceSummary;
    metrics: PerformanceMetrics[];
    thresholdViolations: ThresholdViolation[];
    virtualUsers: VirtualUserResult[];
    errors: PerformanceError[];
    environment: EnvironmentInfo;
}

export interface PerformanceSummary {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    errorRate: number;
    averageResponseTime: number;
    maxResponseTime: number;
    minResponseTime: number;
    throughput: number;
    concurrentUsers: {
        max: number;
        average: number;
    };
    dataTransferred: {
        sent: number;
        received: number;
        total: number;
    };
    testEfficiency: number; // percentage of successful operations
}

export interface ThresholdViolation {
    timestamp: number;
    metric: string;
    actualValue: number;
    thresholdValue: number;
    severity: 'warning' | 'critical';
    description: string;
    context?: any;
}

export interface VirtualUserResult {
    id: string;
    startTime: number;
    endTime: number;
    requestCount: number;
    successCount: number;
    errorCount: number;
    averageResponseTime: number;
    totalDataTransferred: number;
    errors: string[];
}

export interface PerformanceError {
    timestamp: number;
    virtualUserId?: string;
    errorType: string;
    message: string;
    statusCode?: number;
    requestUrl?: string;
    responseTime?: number;
    stackTrace?: string;
}

export interface EnvironmentInfo {
    os: string;
    nodeVersion: string;
    frameworkVersion: string;
    testRunId: string;
    hostInfo: {
        hostname: string;
        platform: string;
        architecture: string;
        cpuCores: number;
        totalMemory: number;
    };
}

export interface PerformanceReportConfig {
    includeCharts: boolean;
    includeRawMetrics: boolean;
    includeSystemMetrics: boolean;
    includeErrorDetails: boolean;
    outputFormat: 'html' | 'json' | 'csv' | 'junit' | 'all';
    outputPath?: string;
    realTimeUpdates?: boolean;
    aggregationInterval?: number; // seconds
}

export interface RealTimeMetrics {
    currentVirtualUsers: number;
    currentThroughput: number;
    currentResponseTime: number;
    currentErrorRate: number;
    elapsedTime: number;
    estimatedTimeRemaining: number;
    status: string;
    lastUpdate: number;
}

// Event types for real-time monitoring
export type PerformanceEventType =
    | 'test-started'
    | 'test-completed'
    | 'test-failed'
    | 'test-stopped'
    | 'virtual-user-started'
    | 'virtual-user-completed'
    | 'request-sent'
    | 'request-completed'
    | 'request-failed'
    | 'threshold-violated'
    | 'metrics-updated'
    | 'page-loaded'
    | 'web-vitals-measured'
    | 'visual-comparison-completed';

export interface PerformanceEvent {
    type: PerformanceEventType;
    timestamp: number;
    testId: string;
    data: any;
}

// UI Performance Types
export interface CoreWebVitalsMetrics {
    lcp?: number; // Largest Contentful Paint
    fid?: number; // First Input Delay
    cls?: number; // Cumulative Layout Shift
    fcp?: number; // First Contentful Paint
    ttfb?: number; // Time to First Byte
    inp?: number; // Interaction to Next Paint
}

export interface UIPerformanceMetrics extends PerformanceMetrics {
    webVitals?: CoreWebVitalsMetrics;
    pageLoad: {
        domContentLoaded: number;
        loadComplete: number;
        firstPaint: number;
        firstContentfulPaint: number;
        largestContentfulPaint: number;
    };
    resources: {
        totalSize: number;
        totalCount: number;
        imageSize: number;
        jsSize: number;
        cssSize: number;
        cacheHitRate: number;
    };
    navigation: {
        type: 'navigate' | 'reload' | 'back_forward' | 'prerender';
        redirectCount: number;
        transferSize: number;
    };
    visual: {
        viewport: { width: number; height: number };
        devicePixelRatio: number;
        screenshots?: string[];
        visualDifferences?: number;
    };
}

export interface UIPerformanceScenarioConfig extends PerformanceScenarioConfig {
    testType: 'ui-load' | 'ui-stress' | 'core-web-vitals' | 'page-load' | 'visual-regression';
    browserConfig: BrowserConfiguration;
    pages: PageConfiguration[];
    visualTesting?: VisualTestingConfig;
    webVitalsThresholds?: CoreWebVitalsThresholds;
}

export interface BrowserConfiguration {
    browserType: 'chromium' | 'firefox' | 'webkit';
    headless?: boolean;
    viewport?: { width: number; height: number };
    deviceEmulation?: string; // Device name for mobile testing
    networkThrottling?: NetworkThrottlingConfig;
    cacheStrategy?: 'disabled' | 'enabled' | 'clear-between-tests';
    recordVideo?: boolean;
    recordTrace?: boolean;
}

export interface PageConfiguration {
    url: string;
    name: string;
    waitConditions?: ('load' | 'domcontentloaded' | 'networkidle')[];
    interactions?: UserInteraction[];
    customMetrics?: string[]; // Custom JS to evaluate for metrics
    excludeResources?: string[]; // Resource patterns to exclude from measurement
}

export interface UserInteraction {
    type: 'click' | 'type' | 'scroll' | 'hover' | 'wait';
    selector?: string;
    text?: string;
    delay?: number;
    measureAfter?: boolean; // Whether to measure performance after this interaction
}

export interface NetworkThrottlingConfig {
    downloadSpeed?: number; // bytes per second
    uploadSpeed?: number; // bytes per second
    latency?: number; // milliseconds
}

export interface VisualTestingConfig {
    enabled: boolean;
    threshold?: number; // Visual difference threshold (0-1)
    fullPage?: boolean;
    mask?: string[]; // Selectors to mask during comparison
    clip?: { x: number; y: number; width: number; height: number };
    animations?: 'disabled' | 'allow';
}

export interface CoreWebVitalsThresholds {
    lcp?: { good: number; needsImprovement: number }; // e.g., { good: 2500, needsImprovement: 4000 }
    fid?: { good: number; needsImprovement: number }; // e.g., { good: 100, needsImprovement: 300 }
    cls?: { good: number; needsImprovement: number }; // e.g., { good: 0.1, needsImprovement: 0.25 }
    fcp?: { good: number; needsImprovement: number }; // e.g., { good: 1800, needsImprovement: 3000 }
    ttfb?: { good: number; needsImprovement: number }; // e.g., { good: 800, needsImprovement: 1800 }
}

export interface UITestResult extends PerformanceTestResult {
    uiMetrics: UIPerformanceMetrics[];
    webVitalsScores: {
        lcp: 'good' | 'needs-improvement' | 'poor';
        fid: 'good' | 'needs-improvement' | 'poor';
        cls: 'good' | 'needs-improvement' | 'poor';
        fcp: 'good' | 'needs-improvement' | 'poor';
        ttfb: 'good' | 'needs-improvement' | 'poor';
        overall: 'good' | 'needs-improvement' | 'poor';
    };
    visualResults?: VisualComparisonResult[];
    pageLoadResults: PageLoadResult[];
}

export interface VisualComparisonResult {
    pageName: string;
    passed: boolean;
    differencePercentage: number;
    baselineImage: string;
    actualImage: string;
    diffImage?: string;
    timestamp: number;
}

export interface PageLoadResult {
    url: string;
    pageName: string;
    loadTime: number;
    domContentLoadedTime: number;
    webVitals: CoreWebVitalsMetrics;
    resourceMetrics: {
        totalRequests: number;
        totalSize: number;
        slowestResource: { url: string; duration: number };
    };
    errors: string[];
}

// Callback types
export type PerformanceEventCallback = (event: PerformanceEvent) => void;
export type MetricsCallback = (metrics: PerformanceMetrics) => void;
export type ThresholdViolationCallback = (violation: ThresholdViolation) => void;
export type UIMetricsCallback = (metrics: UIPerformanceMetrics) => void;