import { Page } from 'playwright';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSBrowserManager } from '../browser/CSBrowserManager';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface PerformanceMetrics {
    timestamp: number;
    url?: string;
    
    // Core Web Vitals
    lcp?: number; // Largest Contentful Paint
    fid?: number; // First Input Delay
    cls?: number; // Cumulative Layout Shift
    fcp?: number; // First Contentful Paint
    ttfb?: number; // Time to First Byte
    
    // Navigation Timing
    navigationStart?: number;
    domContentLoaded?: number;
    loadComplete?: number;
    
    // Resource Performance
    resourceCount?: number;
    totalResourceSize?: number;
    totalTransferSize?: number;
    
    // System Resources
    cpuUsage?: number;
    memoryUsage?: number;
    
    //=========Performance Testing Items Starts here==========//
    // Load Testing Metrics (Enhanced)
    concurrentUsers?: number;
    requestsPerSecond?: number;
    responseTime?: number;
    errorRate?: number;
    throughput?: number;
    activeConnections?: number;
    queueLength?: number;
    //==========Perfromance Testing Items ends here===========//


    // Custom Metrics
    customMetrics?: Record<string, number>;
}

export interface PerformanceThreshold {
    metric: string;
    warning: number;
    error: number;
    unit: string;
}

export interface PerformanceBudget {
    name: string;
    thresholds: PerformanceThreshold[];
    enabled: boolean;
}

export interface PerformanceReport {
    testName: string;
    startTime: number;
    endTime: number;
    duration: number;
    metrics: PerformanceMetrics[];
    violations: PerformanceViolation[];
    summary: PerformanceSummary;
}

export interface PerformanceViolation {
    timestamp: number;
    metric: string;
    actual: number;
    threshold: number;
    severity: 'warning' | 'error';
    url?: string;
}

export interface PerformanceSummary {
    avgLCP?: number;
    avgFID?: number;
    avgCLS?: number;
    avgFCP?: number;
    avgTTFB?: number;
    totalViolations: number;
    warningCount: number;
    errorCount: number;
}

export class CSPerformanceMonitor {
    private static instance: CSPerformanceMonitor;
    private config: CSConfigurationManager;
    private metrics: PerformanceMetrics[] = [];
    private budgets: PerformanceBudget[] = [];
    private violations: PerformanceViolation[] = [];
    private isMonitoring: boolean = false;
    private monitoringInterval?: NodeJS.Timeout;
    private currentTestName?: string;
    private testStartTime?: number;
    private resourceObserver?: PerformanceObserver;
    private metricsDir: string;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.metricsDir = this.config.get('PERFORMANCE_METRICS_DIR', './metrics');
        this.initializeDefaultBudgets();
        this.ensureMetricsDirectory();
    }

    public static getInstance(): CSPerformanceMonitor {
        if (!CSPerformanceMonitor.instance) {
            CSPerformanceMonitor.instance = new CSPerformanceMonitor();
        }
        return CSPerformanceMonitor.instance;
    }

    private async ensureMetricsDirectory(): Promise<void> {
        try {
            await fs.mkdir(this.metricsDir, { recursive: true });
        } catch (error) {
            CSReporter.warn(`Failed to create metrics directory: ${(error as Error).message}`);
        }
    }

    private initializeDefaultBudgets(): void {
        const defaultBudgets: PerformanceBudget[] = [
            {
                name: 'Core Web Vitals',
                enabled: this.config.getBoolean('PERFORMANCE_CORE_WEB_VITALS_ENABLED', true),
                thresholds: [
                    { metric: 'lcp', warning: 2500, error: 4000, unit: 'ms' },
                    { metric: 'fid', warning: 100, error: 300, unit: 'ms' },
                    { metric: 'cls', warning: 0.1, error: 0.25, unit: 'score' },
                    { metric: 'fcp', warning: 1800, error: 3000, unit: 'ms' },
                    { metric: 'ttfb', warning: 800, error: 1800, unit: 'ms' }
                ]
            },
            {
                name: 'Resource Performance',
                enabled: this.config.getBoolean('PERFORMANCE_RESOURCE_BUDGET_ENABLED', true),
                thresholds: [
                    { metric: 'totalResourceSize', warning: 5000000, error: 10000000, unit: 'bytes' },
                    { metric: 'resourceCount', warning: 100, error: 200, unit: 'count' }
                ]
            },
            {
                name: 'System Performance',
                enabled: this.config.getBoolean('PERFORMANCE_SYSTEM_BUDGET_ENABLED', false),
                thresholds: [
                    { metric: 'cpuUsage', warning: 80, error: 95, unit: '%' },
                    { metric: 'memoryUsage', warning: 80, error: 95, unit: '%' }
                ]
            }
        ];

        this.budgets = defaultBudgets.filter(budget => budget.enabled);
        CSReporter.debug(`Initialized ${this.budgets.length} performance budgets`);
    }

    public async startMonitoring(testName?: string): Promise<void> {
        if (this.isMonitoring) {
            CSReporter.warn('Performance monitoring already active');
            return;
        }

        this.currentTestName = testName;
        this.testStartTime = Date.now();
        this.metrics = [];
        this.violations = [];
        this.isMonitoring = true;

        CSReporter.info(`Starting performance monitoring${testName ? ` for: ${testName}` : ''}`);

        // Initialize browser-based monitoring
        await this.initializeBrowserMonitoring();

        // Start system resource monitoring
        const monitoringInterval = this.config.getNumber('PERFORMANCE_MONITORING_INTERVAL', 1000);
        this.monitoringInterval = setInterval(() => {
            this.collectSystemMetrics();
        }, monitoringInterval);

        CSReporter.pass('Performance monitoring started');
    }

    public async stopMonitoring(): Promise<PerformanceReport | null> {
        if (!this.isMonitoring) {
            CSReporter.warn('Performance monitoring not active');
            return null;
        }

        this.isMonitoring = false;
        const endTime = Date.now();

        // Clear interval
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.monitoringInterval = undefined;
        }

        // Clean up browser monitoring
        await this.cleanupBrowserMonitoring();

        // Generate final report
        const report = await this.generateReport(endTime);

        // Save report
        await this.saveReport(report);

        CSReporter.info(`Performance monitoring stopped - Duration: ${report.duration}ms, Violations: ${report.violations.length}, Metrics: ${report.metrics.length}`);

        return report;
    }

    private async initializeBrowserMonitoring(): Promise<void> {
        try {
            const page = CSBrowserManager.getInstance().getPage();
            if (!page) return;

            // Inject performance monitoring script
            await page.addInitScript(() => {
                // Store reference to original methods
                const originalFetch = window.fetch;
                const originalXHR = XMLHttpRequest.prototype.open;

                // Performance observer for Web Vitals
                if (window.PerformanceObserver) {
                    const observer = new PerformanceObserver((list) => {
                        for (const entry of list.getEntries()) {
                            (window as any).__csMetrics = (window as any).__csMetrics || [];
                            (window as any).__csMetrics.push({
                                name: entry.name,
                                type: entry.entryType,
                                startTime: entry.startTime,
                                duration: entry.duration,
                                timestamp: Date.now()
                            });
                        }
                    });

                    observer.observe({ entryTypes: ['navigation', 'paint', 'largest-contentful-paint', 'first-input', 'layout-shift'] });
                }

                // Web Vitals calculation
                (window as any).__calculateWebVitals = () => {
                    const metrics = {
                        lcp: 0,
                        fid: 0,
                        cls: 0,
                        fcp: 0,
                        ttfb: 0
                    };

                    // Navigation timing
                    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
                    if (navigation) {
                        metrics.ttfb = navigation.responseStart - navigation.requestStart;
                    }

                    // Paint timing
                    const paintEntries = performance.getEntriesByType('paint');
                    const fcp = paintEntries.find(entry => entry.name === 'first-contentful-paint');
                    if (fcp) {
                        metrics.fcp = fcp.startTime;
                    }

                    // LCP
                    const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
                    if (lcpEntries.length > 0) {
                        metrics.lcp = lcpEntries[lcpEntries.length - 1].startTime;
                    }

                    // CLS - sum of all layout shift scores
                    const layoutShifts = performance.getEntriesByType('layout-shift');
                    metrics.cls = layoutShifts.reduce((sum, entry: any) => sum + entry.value, 0);

                    return metrics;
                };
            });

            CSReporter.debug('Browser performance monitoring initialized');

        } catch (error) {
            CSReporter.warn(`Failed to initialize browser monitoring: ${(error as Error).message}`);
        }
    }

    private async cleanupBrowserMonitoring(): Promise<void> {
        try {
            const page = CSBrowserManager.getInstance().getPage();
            if (!page) return;

            // Collect final metrics from browser
            const browserMetrics = await page.evaluate(() => {
                return (window as any).__calculateWebVitals?.();
            });

            if (browserMetrics) {
                const metrics: PerformanceMetrics = {
                    timestamp: Date.now(),
                    url: page.url(),
                    ...browserMetrics
                };

                this.metrics.push(metrics);
                this.checkThresholds(metrics);
            }

            CSReporter.debug('Browser performance monitoring cleaned up');

        } catch (error) {
            CSReporter.warn(`Failed to cleanup browser monitoring: ${(error as Error).message}`);
        }
    }

    private async collectSystemMetrics(): Promise<void> {
        try {
            const metrics: PerformanceMetrics = {
                timestamp: Date.now(),
                cpuUsage: await this.getCPUUsage(),
                memoryUsage: this.getMemoryUsage()
            };

            // Add browser-specific metrics if available
            const page = CSBrowserManager.getInstance().getPage();
            if (page) {
                try {
                    const browserMetrics = await page.evaluate(() => {
                        const webVitals = (window as any).__calculateWebVitals?.();
                        const resources = performance.getEntriesByType('resource');
                        
                        return {
                            ...webVitals,
                            resourceCount: resources.length,
                            totalResourceSize: resources.reduce((sum, r: any) => sum + (r.transferSize || 0), 0)
                        };
                    });

                    Object.assign(metrics, browserMetrics);
                    metrics.url = page.url();
                } catch {
                    // Ignore browser metric collection errors
                }
            }

            this.metrics.push(metrics);
            this.checkThresholds(metrics);

        } catch (error) {
            CSReporter.debug(`Failed to collect system metrics: ${(error as Error).message}`);
        }
    }

    private async getCPUUsage(): Promise<number> {
        // Simplified CPU usage calculation
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;

        for (const cpu of cpus) {
            for (const type in cpu.times) {
                totalTick += (cpu.times as any)[type];
            }
            totalIdle += cpu.times.idle;
        }

        const idle = totalIdle / cpus.length;
        const total = totalTick / cpus.length;
        const usage = 100 - ~~(100 * idle / total);

        return Math.max(0, Math.min(100, usage));
    }

    private getMemoryUsage(): number {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        return Math.round((usedMem / totalMem) * 100);
    }

    private checkThresholds(metrics: PerformanceMetrics): void {
        for (const budget of this.budgets) {
            for (const threshold of budget.thresholds) {
                const value = (metrics as any)[threshold.metric];
                if (value !== undefined) {
                    let severity: 'warning' | 'error' | null = null;

                    if (value >= threshold.error) {
                        severity = 'error';
                    } else if (value >= threshold.warning) {
                        severity = 'warning';
                    }

                    if (severity) {
                        const violation: PerformanceViolation = {
                            timestamp: metrics.timestamp,
                            metric: threshold.metric,
                            actual: value,
                            threshold: severity === 'error' ? threshold.error : threshold.warning,
                            severity,
                            url: metrics.url
                        };

                        this.violations.push(violation);

                        const message = `Performance ${severity}: ${threshold.metric} = ${value}${threshold.unit} (threshold: ${violation.threshold}${threshold.unit})`;
                        
                        if (severity === 'error') {
                            CSReporter.fail(message);
                        } else {
                            CSReporter.warn(message);
                        }
                    }
                }
            }
        }
    }

    private async generateReport(endTime: number): Promise<PerformanceReport> {
        const startTime = this.testStartTime || Date.now();
        const summary = this.calculateSummary();

        const report: PerformanceReport = {
            testName: this.currentTestName || 'Unknown',
            startTime,
            endTime,
            duration: endTime - startTime,
            metrics: [...this.metrics],
            violations: [...this.violations],
            summary
        };

        return report;
    }

    private calculateSummary(): PerformanceSummary {
        const validMetrics = this.metrics.filter(m => m.lcp || m.fid || m.cls || m.fcp || m.ttfb);
        
        const summary: PerformanceSummary = {
            totalViolations: this.violations.length,
            warningCount: this.violations.filter(v => v.severity === 'warning').length,
            errorCount: this.violations.filter(v => v.severity === 'error').length
        };

        if (validMetrics.length > 0) {
            const lcpValues = validMetrics.map(m => m.lcp).filter(Boolean) as number[];
            const fidValues = validMetrics.map(m => m.fid).filter(Boolean) as number[];
            const clsValues = validMetrics.map(m => m.cls).filter(Boolean) as number[];
            const fcpValues = validMetrics.map(m => m.fcp).filter(Boolean) as number[];
            const ttfbValues = validMetrics.map(m => m.ttfb).filter(Boolean) as number[];

            if (lcpValues.length > 0) summary.avgLCP = lcpValues.reduce((a, b) => a! + b!, 0) / lcpValues.length;
            if (fidValues.length > 0) summary.avgFID = fidValues.reduce((a, b) => a! + b!, 0) / fidValues.length;
            if (clsValues.length > 0) summary.avgCLS = clsValues.reduce((a, b) => a! + b!, 0) / clsValues.length;
            if (fcpValues.length > 0) summary.avgFCP = fcpValues.reduce((a, b) => a! + b!, 0) / fcpValues.length;
            if (ttfbValues.length > 0) summary.avgTTFB = ttfbValues.reduce((a, b) => a! + b!, 0) / ttfbValues.length;
        }

        return summary;
    }

    private async saveReport(report: PerformanceReport): Promise<void> {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = `performance-${report.testName}-${timestamp}.json`;
            const filepath = path.join(this.metricsDir, filename);

            await fs.writeFile(filepath, JSON.stringify(report, null, 2));
            CSReporter.info(`Performance report saved: ${filepath}`);

            // Also save a summary CSV for easy analysis
            await this.saveSummaryCSV(report);

        } catch (error) {
            CSReporter.warn(`Failed to save performance report: ${(error as Error).message}`);
        }
    }

    private async saveSummaryCSV(report: PerformanceReport): Promise<void> {
        try {
            const csvFile = path.join(this.metricsDir, 'performance-summary.csv');
            
            // Check if file exists to determine if we need headers
            let needsHeaders = false;
            try {
                await fs.access(csvFile);
            } catch {
                needsHeaders = true;
            }

            const csvRow = [
                report.testName,
                new Date(report.startTime).toISOString(),
                report.duration,
                report.summary.avgLCP?.toFixed(2) || '',
                report.summary.avgFID?.toFixed(2) || '',
                report.summary.avgCLS?.toFixed(3) || '',
                report.summary.avgFCP?.toFixed(2) || '',
                report.summary.avgTTFB?.toFixed(2) || '',
                report.summary.totalViolations,
                report.summary.warningCount,
                report.summary.errorCount
            ].join(',');

            let content = '';
            if (needsHeaders) {
                content = 'TestName,StartTime,Duration,AvgLCP,AvgFID,AvgCLS,AvgFCP,AvgTTFB,TotalViolations,Warnings,Errors\n';
            }
            content += csvRow + '\n';

            await fs.appendFile(csvFile, content);

        } catch (error) {
            CSReporter.debug(`Failed to save performance summary CSV: ${(error as Error).message}`);
        }
    }

    public async measurePageLoad(page: Page, url: string): Promise<PerformanceMetrics> {
        CSReporter.info(`Measuring page load performance for: ${url}`);

        const startTime = Date.now();
        await page.goto(url, { waitUntil: 'networkidle' });

        // Wait for performance metrics to stabilize
        await page.waitForTimeout(2000);

        const metrics = await page.evaluate(() => {
            return (window as any).__calculateWebVitals?.() || {};
        });

        const resourceMetrics = await page.evaluate(() => {
            const resources = performance.getEntriesByType('resource');
            return {
                resourceCount: resources.length,
                totalResourceSize: resources.reduce((sum, r: any) => sum + (r.decodedBodySize || 0), 0),
                totalTransferSize: resources.reduce((sum, r: any) => sum + (r.transferSize || 0), 0)
            };
        });

        const performanceMetrics: PerformanceMetrics = {
            timestamp: Date.now(),
            url,
            ...metrics,
            ...resourceMetrics
        };

        this.checkThresholds(performanceMetrics);
        
        CSReporter.pass(`Page load measurement completed for: ${url} - LCP: ${metrics.lcp ? `${metrics.lcp}ms` : 'N/A'}, FCP: ${metrics.fcp ? `${metrics.fcp}ms` : 'N/A'}, Resources: ${resourceMetrics.resourceCount}`);

        return performanceMetrics;
    }

    public addCustomBudget(budget: PerformanceBudget): void {
        this.budgets.push(budget);
        CSReporter.info(`Added custom performance budget: ${budget.name}`);
    }

    public getViolations(): PerformanceViolation[] {
        return [...this.violations];
    }

    public getLatestMetrics(count: number = 10): PerformanceMetrics[] {
        return this.metrics.slice(-count);
    }

    public async generateHTMLReport(report: PerformanceReport): Promise<string> {
        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Performance Report - ${report.testName}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background: #f5f5f5; padding: 20px; border-radius: 8px; }
        .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 20px 0; }
        .metric { background: white; border: 1px solid #ddd; padding: 15px; border-radius: 8px; }
        .metric.warning { border-left: 4px solid #ff9800; }
        .metric.error { border-left: 4px solid #f44336; }
        .violations { margin-top: 20px; }
        .violation { padding: 10px; margin: 5px 0; border-radius: 4px; }
        .violation.warning { background: #fff3cd; }
        .violation.error { background: #f8d7da; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Performance Report: ${report.testName}</h1>
        <p>Duration: ${report.duration}ms | Violations: ${report.violations.length}</p>
    </div>
    
    <div class="metrics">
        ${report.summary.avgLCP ? `<div class="metric ${report.summary.avgLCP > 2500 ? 'warning' : ''}">
            <h3>Largest Contentful Paint</h3>
            <p>${report.summary.avgLCP.toFixed(2)}ms</p>
        </div>` : ''}
        
        ${report.summary.avgFID ? `<div class="metric ${report.summary.avgFID > 100 ? 'warning' : ''}">
            <h3>First Input Delay</h3>
            <p>${report.summary.avgFID.toFixed(2)}ms</p>
        </div>` : ''}
        
        ${report.summary.avgCLS ? `<div class="metric ${report.summary.avgCLS > 0.1 ? 'warning' : ''}">
            <h3>Cumulative Layout Shift</h3>
            <p>${report.summary.avgCLS.toFixed(3)}</p>
        </div>` : ''}
    </div>
    
    <div class="violations">
        <h2>Performance Violations</h2>
        ${report.violations.map(violation => `
            <div class="violation ${violation.severity}">
                <strong>${violation.metric}</strong>: ${violation.actual} (threshold: ${violation.threshold}) - ${violation.severity}
            </div>
        `).join('')}
    </div>
</body>
</html>`;

        const reportPath = path.join(this.metricsDir, `performance-${report.testName}-${Date.now()}.html`);
        await fs.writeFile(reportPath, html);
        
        CSReporter.info(`HTML performance report generated: ${reportPath}`);
        return reportPath;
    }

    public isActive(): boolean {
        return this.isMonitoring;
    }

//═══════Performance Testing Items Starts here═══════//

// Enhanced methods for Performance Testing Integration

/**
 * Record load testing metrics during performance testing scenarios
 */
public recordLoadTestMetrics(metrics: {
    concurrentUsers: number,
    requestsPerSecond: number,
    responseTime: number,
    errorRate: number,
    throughput: number,
    activeConnections: number,
    queueLength: number,
    url: string,
}): void {
    if (!this.isMonitoring) return;

    const performanceMetric: PerformanceMetrics = {
        timestamp: Date.now(),
        url: metrics.url,
        concurrentUsers: metrics.concurrentUsers,
        requestsPerSecond: metrics.requestsPerSecond,
        responseTime: metrics.responseTime,
        errorRate: metrics.errorRate,
        throughput: metrics.throughput,
        activeConnections: metrics.activeConnections,
        queueLength: metrics.queueLength
    };

    this.metrics.push(performanceMetric);
    this.checkLoadTestThresholds(performanceMetric);
}

/**
 * Check load testing specific thresholds
 */
private checkLoadTestThresholds(metrics: PerformanceMetrics): void {
    const loadTestBudgets = this.budgets.filter(b => b.name.includes('Load') || b.name.includes('Performance Test'));

    for (const budget of loadTestBudgets) {
        for (const threshold of budget.thresholds) {
            const value = (metrics as any)[threshold.metric];
            if (value !== undefined) {
                let severity: 'warning' | 'error' | null = null;
                let thresholdValue = 0;

                if (value > threshold.error) {
                    severity = 'error';
                    thresholdValue = threshold.error;
                } else if (value > threshold.warning) {
                    severity = 'warning';
                    thresholdValue = threshold.warning;
                }

                if (severity) {
                    const violation: PerformanceViolation = {
                        timestamp: metrics.timestamp,
                        metric: threshold.metric,
                        actual: value,
                        threshold: thresholdValue,
                        severity,
                        url: metrics.url
                    };

                    this.violations.push(violation);

                    const message = `Load Test ${severity}: ${threshold.metric} = ${value}${threshold.unit} (threshold: ${thresholdValue}${threshold.unit})`;

                    if (severity === 'error') {
                        CSReporter.fail(message);
                    } else {
                        CSReporter.warn(message);
                    }
                }
            }
        }
    }
}

/**
 * Add performance budgets for load testing
 */
public addLoadTestingBudgets(): void {
    const loadTestBudget: PerformanceBudget = {
        name: 'Load Testing Performance',
        enabled: true,
        thresholds: [
            { metric: 'responseTime', warning: 1000, error: 2000, unit: 'ms' },
            { metric: 'errorRate', warning: 0.05, error: 0.10, unit: '%' },
            { metric: 'requestsPerSecond', warning: 50, error: 20, unit: 'rps' },
            { metric: 'throughput', warning: 1000, error: 100, unit: 'KB/s' },
            { metric: 'activeConnections', warning: 1000, error: 2000, unit: 'count' }
        ]
    };

    // Check if already exists
    const existingIndex = this.budgets.findIndex(b => b.name === loadTestBudget.name);
    if (existingIndex >= 0) {
        this.budgets[existingIndex] = loadTestBudget;
    } else {
        this.budgets.push(loadTestBudget);
    }

    CSReporter.info('Load testing performance budgets added');
}

/**
 * Start concurrent monitoring for multiple virtual users
 */
public async startConcurrentMonitoring(testName: string, virtualUsers: number): Promise<void> {
    await this.startMonitoring(`${testName}-${virtualUsers}users`);
    this.addLoadTestingBudgets();

    // Record initial concurrent user count
    this.recordLoadTestMetrics({
        concurrentUsers: virtualUsers,
        timestamp: Date.now()
    } as any);
}

/**
 * Get current load testing summary
 */
public getLoadTestSummary(): {
    avgResponseTime: number;
    avgErrorRate: number;
    avgThroughput: number;
    peakConcurrentUsers: number;
    totalRequests: number;
} {
    const loadMetrics = this.metrics.filter(m => m.responseTime !== undefined || m.errorRate !== undefined);

    if (loadMetrics.length === 0) {
        return {
            avgResponseTime: 0,
            avgErrorRate: 0,
            avgThroughput: 0,
            peakConcurrentUsers: 0,
            totalRequests: 0
        };
    }

    const responseTimes = loadMetrics.filter(m => m.responseTime !== undefined).map(m => m.responseTime!);
    const errorRates = loadMetrics.filter(m => m.errorRate !== undefined).map(m => m.errorRate!);
    const throughputs = loadMetrics.filter(m => m.throughput !== undefined).map(m => m.throughput!);
    const concurrentUsers = loadMetrics.filter(m => m.concurrentUsers !== undefined).map(m => m.concurrentUsers!);

    return {
        avgResponseTime: responseTimes.length > 0 ? responseTimes.reduce((a: number, b: number) => a + b, 0) / responseTimes.length : 0,
        avgErrorRate: errorRates.length > 0 ? errorRates.reduce((a: number, b: number) => a + b, 0) / errorRates.length : 0,
        avgThroughput: throughputs.length > 0 ? throughputs.reduce((a: number, b: number) => a + b, 0) / throughputs.length : 0,
        peakConcurrentUsers: concurrentUsers.length > 0 ? Math.max(...concurrentUsers) : 0,
        totalRequests: loadMetrics.length
    };
}

/**
 * Export metrics in format compatible with performance testing module
 */
public exportForPerformanceTesting(): {
    metrics: PerformanceMetrics[];
    violations: PerformanceViolation[];
    summary: any;
    testDuration: number;
} {
    const summary = this.getLoadTestSummary();
    const testDuration = this.testStartTime ? Date.now() - this.testStartTime : 0;

    return {
        metrics: [...this.metrics],
        violations: [...this.violations],
        summary,
        testDuration
    };
}

//═══════Performance Testing Items Ends here═══════//

}