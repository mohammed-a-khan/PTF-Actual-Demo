import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import {
    PerformanceTestResult,
    PerformanceScenarioConfig,
    PerformanceReportConfig,
    PerformanceMetrics,
    ThresholdViolation,
    PerformanceSummary,
    RealTimeMetrics
} from './types/CSPerformanceTypes';

/**
 * CS Performance Reporter
 * Generates comprehensive performance test reports with real-time metrics and analytics
 */
export class CSPerformanceReporter {
    private static instance: CSPerformanceReporter;
    private config: CSConfigurationManager;
    private activeReports: Map<string, PerformanceReportSession>;
    private reportConfigs: Map<string, PerformanceReportConfig>;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.activeReports = new Map();
        this.reportConfigs = new Map();
        this.initializeDefaultReportConfig();
    }

    public static getInstance(): CSPerformanceReporter {
        if (!CSPerformanceReporter.instance) {
            CSPerformanceReporter.instance = new CSPerformanceReporter();
        }
        return CSPerformanceReporter.instance;
    }

    private initializeDefaultReportConfig(): void {
        const defaultConfig: PerformanceReportConfig = {
            includeCharts: this.config.getBoolean('PERFORMANCE_REPORT_CHARTS', true),
            includeRawMetrics: this.config.getBoolean('PERFORMANCE_REPORT_RAW_METRICS', false),
            includeSystemMetrics: this.config.getBoolean('PERFORMANCE_REPORT_SYSTEM_METRICS', true),
            includeErrorDetails: this.config.getBoolean('PERFORMANCE_REPORT_ERROR_DETAILS', true),
            outputFormat: this.config.get('PERFORMANCE_REPORT_FORMAT', 'html') as any,
            outputPath: this.config.get('PERFORMANCE_REPORT_PATH', './performance-reports'),
            realTimeUpdates: this.config.getBoolean('PERFORMANCE_REPORT_REAL_TIME', false),
            aggregationInterval: this.config.getNumber('PERFORMANCE_REPORT_AGGREGATION_INTERVAL', 5)
        };

        this.reportConfigs.set('default', defaultConfig);
    }

    /**
     * Initialize performance report for a test
     */
    public async initializeTest(testId: string, scenarioConfig: PerformanceScenarioConfig, reportConfig?: PerformanceReportConfig): Promise<void> {
        const config = reportConfig || this.reportConfigs.get('default')!;

        const session: PerformanceReportSession = {
            testId,
            scenarioConfig,
            reportConfig: config,
            startTime: Date.now(),
            metricsHistory: [],
            thresholdViolations: [],
            realTimeData: {
                currentVirtualUsers: 0,
                currentThroughput: 0,
                currentResponseTime: 0,
                currentErrorRate: 0,
                elapsedTime: 0,
                estimatedTimeRemaining: 0,
                status: 'initializing',
                lastUpdate: Date.now()
            }
        };

        this.activeReports.set(testId, session);

        // Create output directory if needed
        if (config.outputPath) {
            try {
                const path = require('path');
                const fs = require('fs').promises;
                await fs.mkdir(config.outputPath, { recursive: true });
            } catch (error) {
                CSReporter.warn(`Failed to create report output directory: ${(error as Error).message}`);
            }
        }

        CSReporter.info(`Performance report initialized for test: ${testId}`);

        if (config.realTimeUpdates) {
            this.startRealTimeReporting(testId);
        }
    }

    /**
     * Update metrics for real-time reporting
     */
    public async updateMetrics(testId: string, metrics: PerformanceMetrics): Promise<void> {
        const session = this.activeReports.get(testId);
        if (!session) return;

        // Add metrics to history
        session.metricsHistory.push(metrics);

        // Update real-time data
        session.realTimeData = {
            currentVirtualUsers: metrics.virtualUsers.active,
            currentThroughput: metrics.throughput.requestsPerSecond,
            currentResponseTime: metrics.timing.averageResponseTime,
            currentErrorRate: metrics.errors.rate,
            elapsedTime: Date.now() - session.startTime,
            estimatedTimeRemaining: 0, // TODO: Calculate based on scenario config
            status: 'running',
            lastUpdate: Date.now()
        };

        // Aggregate metrics if needed
        if (session.reportConfig.aggregationInterval) {
            if (session.metricsHistory.length % session.reportConfig.aggregationInterval === 0) {
                await this.generateAggregatedMetrics(testId);
            }
        }

        // Generate real-time report update if enabled
        if (session.reportConfig.realTimeUpdates) {
            await this.generateRealTimeUpdate(testId);
        }
    }

    /**
     * Add threshold violation
     */
    public async addThresholdViolation(testId: string, violation: ThresholdViolation): Promise<void> {
        const session = this.activeReports.get(testId);
        if (!session) return;

        session.thresholdViolations.push(violation);

        CSReporter.warn(`Performance threshold violation: ${violation.description}`);

        // Generate alert if configured
        if (violation.severity === 'critical') {
            await this.generateCriticalAlert(testId, violation);
        }
    }

    /**
     * Finalize test and generate complete report
     */
    public async finalizeTest(testId: string): Promise<string[]> {
        const session = this.activeReports.get(testId);
        if (!session) {
            throw new Error(`Report session ${testId} not found`);
        }

        session.endTime = Date.now();
        session.realTimeData.status = 'completed';

        CSReporter.info(`Finalizing performance report for test: ${testId}`);

        const reportPaths: string[] = [];

        // Generate reports based on configuration
        if (session.reportConfig.outputFormat === 'html' || session.reportConfig.outputFormat === 'all') {
            const htmlPath = await this.generateHTMLReport(testId);
            reportPaths.push(htmlPath);
        }

        if (session.reportConfig.outputFormat === 'json' || session.reportConfig.outputFormat === 'all') {
            const jsonPath = await this.generateJSONReport(testId);
            reportPaths.push(jsonPath);
        }

        if (session.reportConfig.outputFormat === 'csv' || session.reportConfig.outputFormat === 'all') {
            const csvPath = await this.generateCSVReport(testId);
            reportPaths.push(csvPath);
        }

        if (session.reportConfig.outputFormat === 'junit' || session.reportConfig.outputFormat === 'all') {
            const junitPath = await this.generateJUnitReport(testId);
            reportPaths.push(junitPath);
        }

        CSReporter.info(`Performance reports generated: ${reportPaths.join(', ')}`);

        // Clean up session after delay
        setTimeout(() => {
            this.activeReports.delete(testId);
        }, 60000); // Keep for 1 minute

        return reportPaths;
    }

    /**
     * Export test results in specified format
     */
    public async exportResults(testResult: PerformanceTestResult, format: 'json' | 'csv' | 'html'): Promise<string> {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const baseFileName = `performance-report-${testResult.scenarioName}-${timestamp}`;
        const outputPath = this.config.get('PERFORMANCE_REPORT_PATH', './performance-reports');

        switch (format) {
            case 'json':
                return await this.exportToJSON(testResult, `${outputPath}/${baseFileName}.json`);

            case 'csv':
                return await this.exportToCSV(testResult, `${outputPath}/${baseFileName}.csv`);

            case 'html':
                return await this.exportToHTML(testResult, `${outputPath}/${baseFileName}.html`);

            default:
                throw new Error(`Unsupported export format: ${format}`);
        }
    }

    private async generateHTMLReport(testId: string): Promise<string> {
        const session = this.activeReports.get(testId);
        if (!session) throw new Error(`Session ${testId} not found`);

        const summary = this.calculateSummary(session);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `performance-report-${session.scenarioConfig.name}-${timestamp}.html`;
        const filePath = `${session.reportConfig.outputPath}/${fileName}`;

        const html = this.generateHTMLContent(session, summary);

        try {
            const fs = require('fs').promises;
            await fs.writeFile(filePath, html, 'utf8');
            CSReporter.info(`HTML report generated: ${filePath}`);
            return filePath;
        } catch (error) {
            CSReporter.error(`Failed to generate HTML report: ${(error as Error).message}`);
            throw error;
        }
    }

    private generateHTMLContent(session: PerformanceReportSession, summary: PerformanceSummary): string {
        const duration = ((session.endTime || Date.now()) - session.startTime) / 1000;

        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Performance Test Report - ${session.scenarioConfig.name}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 20px; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .header { text-align: center; margin-bottom: 40px; padding-bottom: 20px; border-bottom: 3px solid #e0e0e0; }
        .header h1 { color: #2c3e50; margin: 0 0 10px 0; }
        .header .subtitle { color: #7f8c8d; font-size: 18px; }
        .metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 40px; }
        .metric-card { background: #f8f9fa; padding: 20px; border-radius: 6px; border-left: 4px solid #3498db; }
        .metric-card.warning { border-left-color: #f39c12; }
        .metric-card.error { border-left-color: #e74c3c; }
        .metric-title { font-size: 14px; color: #7f8c8d; margin-bottom: 8px; font-weight: 600; }
        .metric-value { font-size: 24px; font-weight: bold; color: #2c3e50; }
        .metric-unit { font-size: 14px; color: #7f8c8d; }
        .section { margin-bottom: 40px; }
        .section h2 { color: #2c3e50; margin-bottom: 20px; padding-bottom: 10px; border-bottom: 1px solid #e0e0e0; }
        .violation { background: #fff3cd; padding: 15px; margin: 10px 0; border-radius: 6px; border-left: 4px solid #e74c3c; }
        .violation.warning .violation-title { color: #f39c12; }
        .violation-title { font-weight: bold; color: #e74c3c; margin-bottom: 5px; }
        .test-info { background: #e3f2fd; padding: 20px; border-radius: 6px; margin-bottom: 30px; }
        .test-info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; }
        .info-item { }
        .info-label { font-weight: 600; color: #1565c0; }
        .info-value { color: #2c3e50; }
        .chart-placeholder { background: #f8f9fa; border: 2px dashed #dee2e6; display: flex; align-items: center; justify-content: center; color: #6c757d; border-radius: 6px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #e0e0e0; }
        th { background-color: #f8f9fa; font-weight: 600; color: #2c3e50; }
        .status-running { color: #27ae60; }
        .status-completed { color: #3498db; }
        .status-failed { color: #e74c3c; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Performance Test Report</h1>
            <div class="subtitle">${session.scenarioConfig.name} (${session.scenarioConfig.testType.toUpperCase()})</div>
        </div>

        <div class="test-info">
            <div class="test-info-grid">
                <div class="info-item">
                    <div class="info-label">Test ID:</div>
                    <div class="info-value">${session.testId}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Duration:</div>
                    <div class="info-value">${duration.toFixed(2)}s</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Virtual Users:</div>
                    <div class="info-value">${session.scenarioConfig.loadConfig.virtualUsers}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Load Pattern:</div>
                    <div class="info-value">${session.scenarioConfig.loadConfig.pattern}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Status:</div>
                    <div class="info-value status-${session.realTimeData.status}">${session.realTimeData.status.toUpperCase()}</div>
                </div>
                <div class="info-item">
                    <div class="info-label">Generated:</div>
                    <div class="info-value">${new Date().toLocaleString()}</div>
                </div>
            </div>
        </div>

        <div class="section">
            <h2>Performance Summary</h2>
            <div class="metrics-grid">
                <div class="metric-card">
                    <div class="metric-title">Total Requests</div>
                    <div class="metric-value">${summary.totalRequests.toLocaleString()}</div>
                </div>
                <div class="metric-card ${summary.testEfficiency < 0.5 ? 'error' : summary.errorRate > 1 ? 'warning' : ''}">
                    <div class="metric-title">Success Rate</div>
                    <div class="metric-value">${summary.testEfficiency.toFixed(1)}<span class="metric-unit">%</span></div>
                </div>
                <div class="metric-card">
                    <div class="metric-title">Average Response Time</div>
                    <div class="metric-value">${summary.averageResponseTime.toFixed(0)}<span class="metric-unit">ms</span></div>
                </div>
                <div class="metric-card">
                    <div class="metric-title">Throughput</div>
                    <div class="metric-value">${summary.throughput.toFixed(1)}<span class="metric-unit">req/s</span></div>
                </div>
                <div class="metric-card ${summary.errorRate > 5 ? 'error' : summary.errorRate > 1 ? 'warning' : ''}">
                    <div class="metric-title">Error Rate</div>
                    <div class="metric-value">${summary.errorRate.toFixed(1)}<span class="metric-unit">%</span></div>
                </div>
                <div class="metric-card">
                    <div class="metric-title">Max Users</div>
                    <div class="metric-value">${summary.concurrentUsers.max}</div>
                </div>
            </div>
        </div>

        ${session.thresholdViolations.length > 0 ? `
        <div class="section">
            <h2>Threshold Violations (${session.thresholdViolations.length})</h2>
            ${session.thresholdViolations.map(v => `
                <div class="violation ${v.severity}">
                    <div class="violation-title">${v.severity.toUpperCase()}: ${v.metric}</div>
                    <div>${new Date(v.timestamp).toLocaleTimeString()}</div>
                </div>
            `).join('')}
        </div>` : ''}

        <div class="section">
            <h2>Performance Charts</h2>
            <div class="chart-placeholder">
                <p><small>Chart visualization would be implemented here</small></p>
            </div>
        </div>

        <div class="section">
            <h2>Response Time Statistics</h2>
            <table>
                <thead>
                    <tr>
                        <th>Metric</th>
                        <th>Value (ms)</th>
                    </tr>
                </thead>
                <tbody>
                    <tr><td>Minimum</td><td>${summary.minResponseTime.toFixed(0)}</td></tr>
                    <tr><td>Average</td><td>${summary.averageResponseTime.toFixed(0)}</td></tr>
                    <tr><td>Maximum</td><td>${summary.maxResponseTime.toFixed(0)}</td></tr>
                    <tr><td>50th Percentile</td><td>${this.getLatestPercentile(session, 50).toFixed(0)}</td></tr>
                    <tr><td>95th Percentile</td><td>${this.getLatestPercentile(session, 95).toFixed(0)}</td></tr>
                    <tr><td>99th Percentile</td><td>${this.getLatestPercentile(session, 99).toFixed(0)}</td></tr>
                </tbody>
            </table>
        </div>

        <div class="section">
            <h2>Test Configuration</h2>
            <table>
                <thead>
                    <tr>
                        <th>Parameter</th>
                        <th>Value</th>
                    </tr>
                </thead>
                <tbody>
                    <tr><td>Test Type</td><td>${session.scenarioConfig.testType}</td></tr>
                    <tr><td>Load Pattern</td><td>${session.scenarioConfig.loadConfig.pattern}</td></tr>
                    <tr><td>Virtual Users</td><td>${session.scenarioConfig.loadConfig.virtualUsers}</td></tr>
                    <tr><td>Duration</td><td>${session.scenarioConfig.loadConfig.duration}s</td></tr>
                    <tr><td>Think Time</td><td>${session.scenarioConfig.loadConfig.thinkTime || 0}ms</td></tr>
                    <tr><td>Target URL</td><td>${session.scenarioConfig.targetEndpoint || 'N/A'}</td></tr>
                </tbody>
            </table>
        </div>
    </div>
</body>
</html>`;
    }

    private async generateJSONReport(testId: string): Promise<string> {
        const session = this.activeReports.get(testId);
        if (!session) throw new Error(`Session ${testId} not found`);

        const summary = this.calculateSummary(session);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `performance-report-${session.scenarioConfig.name}-${timestamp}.json`;
        const filePath = `${session.reportConfig.outputPath}/${fileName}`;

        const reportData = {
            testId: session.testId,
            scenarioConfig: session.scenarioConfig,
            summary,
            startTime: session.startTime,
            endTime: session.endTime,
            duration: (session.endTime || Date.now()) - session.startTime,
            metrics: session.metricsHistory,
            thresholdViolations: session.thresholdViolations,
            realTimeData: session.realTimeData
        };

        try {
            const fs = require('fs').promises;
            await fs.writeFile(filePath, JSON.stringify(reportData, null, 2), 'utf8');
            CSReporter.info(`JSON report generated: ${filePath}`);
            return filePath;
        } catch (error) {
            CSReporter.error(`Failed to generate JSON report: ${(error as Error).message}`);
            throw error;
        }
    }

    private async generateCSVReport(testId: string): Promise<string> {
        const session = this.activeReports.get(testId);
        if (!session) throw new Error(`Session ${testId} not found`);

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `performance-metrics-${session.scenarioConfig.name}-${timestamp}.csv`;
        const filePath = `${session.reportConfig.outputPath}/${fileName}`;

        const csvHeader = 'Timestamp,Active Users,Requests,Response Time,Throughput,Error Rate\n';
        const csvRows = session.metricsHistory.map(metric =>
            `${new Date(metric.timestamp).toISOString()},${metric.virtualUsers.active},${metric.requests.completed},${metric.timing.averageResponseTime},${metric.throughput.requestsPerSecond},${metric.errors.rate}`
        ).join('\n');

        try {
            const fs = require('fs').promises;
            await fs.writeFile(filePath, csvHeader + csvRows, 'utf8');
            CSReporter.info(`CSV report generated: ${filePath}`);
            return filePath;
        } catch (error) {
            CSReporter.error(`Failed to generate CSV report: ${(error as Error).message}`);
            throw error;
        }
    }

    private async generateJUnitReport(testId: string): Promise<string> {
        const session = this.activeReports.get(testId);
        if (!session) throw new Error(`Session ${testId} not found`);

        const summary = this.calculateSummary(session);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const fileName = `performance-junit-${session.scenarioConfig.name}-${timestamp}.xml`;
        const filePath = `${session.reportConfig.outputPath}/${fileName}`;

        const duration = ((session.endTime || Date.now()) - session.startTime) / 1000;
        const failures = session.thresholdViolations.filter(v => v.severity === 'critical').length;

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
    <testsuite name="Performance Test - ${session.scenarioConfig.name}"
               tests="1"
               failures="${failures}"
               errors="0"
               time="${duration}">
        <testcase classname="${session.scenarioConfig.name}"
                  name="PerformanceTest"
                  time="${duration}">
            ${failures > 0 ? `
            <failure message="Performance thresholds violated">
                ${session.thresholdViolations.map(v => `${v.description}: ${v.metric}\n`).join('\n')}
            </failure>` : ''}
        </testcase>
        <system-out>
            Total Requests: ${summary.totalRequests}
            Success Rate: ${summary.testEfficiency.toFixed(1)}%
            Average Response Time: ${summary.averageResponseTime.toFixed(0)}ms
            Throughput: ${summary.throughput.toFixed(1)} req/s
            Error Rate: ${summary.errorRate.toFixed(1)}%
        </system-out>
    </testsuite>
</testsuites>`;

        try {
            const fs = require('fs').promises;
            await fs.writeFile(filePath, xml, 'utf8');
            CSReporter.info(`JUnit report generated: ${filePath}`);
            return filePath;
        } catch (error) {
            CSReporter.error(`Failed to generate JUnit report: ${(error as Error).message}`);
            throw error;
        }
    }

    private async exportToJSON(testResult: PerformanceTestResult, filePath: string): Promise<string> {
        try {
            const fs = require('fs').promises;
            await fs.writeFile(filePath, JSON.stringify(testResult, null, 2), 'utf8');
            return filePath;
        } catch (error) {
            CSReporter.error(`Failed to export JSON: ${(error as Error).message}`);
            throw error;
        }
    }

    private async exportToCSV(testResult: PerformanceTestResult, filePath: string): Promise<string> {
        const csvHeader = 'Timestamp,Virtual Users,Active,Requests,Response Time,Throughput,Error Rate\n';
        const csvRows = testResult.metrics.map(m =>
            `${new Date(m.timestamp).toISOString()},${m.virtualUsers.active},${m.requests.completed},${m.timing.averageResponseTime},${m.throughput.requestsPerSecond},${m.errors.rate}`
        ).join('\n');

        try {
            const fs = require('fs').promises;
            await fs.writeFile(filePath, csvHeader + csvRows, 'utf8');
            return filePath;
        } catch (error) {
            CSReporter.error(`Failed to export CSV: ${(error as Error).message}`);
            throw error;
        }
    }

    private async exportToHTML(testResult: PerformanceTestResult, filePath: string): Promise<string> {
        // Generate simplified HTML for standalone export
        const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Performance Test Results - ${testResult.scenarioName}</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .summary { margin-bottom: 30px; padding: 20px; background: #f5f5f5; border-radius: 5px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
        th, td { border: 1px; border-bottom: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
    </style>
</head>
<body>
    <h1>Performance Test Results</h1>
    <h2>${testResult.scenarioName}</h2>
    <div class="summary">
        <p><strong>Duration:</strong> ${testResult.duration / 1000}s</p>
        <p><strong>Total Requests:</strong> ${testResult.summary.totalRequests}</p>
        <p><strong>Success Rate:</strong> ${testResult.summary.testEfficiency.toFixed(1)}%</p>
        <p><strong>Average Response Time:</strong> ${testResult.summary.averageResponseTime.toFixed(0)}ms</p>
        <p><strong>Throughput:</strong> ${testResult.summary.throughput.toFixed(1)} req/s</p>
    </div>
    
    <h2>Threshold Violations</h2>
    <table>
        <thead>
            <tr><th>Time</th><th>Metric</th><th>Severity</th><th>Description</th></tr>
        </thead>
        <tbody>
            ${testResult.thresholdViolations.map(v => `
                <tr>
                    <td>${new Date(v.timestamp).toLocaleTimeString()}</td>
                    <td>${v.metric}</td>
                    <td>${v.severity}</td>
                    <td>${v.description}</td>
                </tr>
            `).join('')}
        </tbody>
    </table>
</body>
</html>`;

        try {
            const fs = require('fs').promises;
            await fs.writeFile(filePath, html, 'utf8');
            return filePath;
        } catch (error) {
            CSReporter.error(`Failed to export HTML: ${(error as Error).message}`);
            throw error;
        }
    }

    private calculateSummary(session: PerformanceReportSession): PerformanceSummary {
        const metrics = session.metricsHistory;
        if (metrics.length === 0) {
            return {
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
            };
        }

        const latestMetric = metrics[metrics.length - 1];
        const maxUsers = Math.max(...metrics.map(m => m.virtualUsers.active));
        const avgUsers = metrics.reduce((sum, m) => sum + m.virtualUsers.active, 0) / metrics.length;

        return {
            totalRequests: latestMetric.requests.sent,
            successfulRequests: latestMetric.requests.completed,
            failedRequests: latestMetric.requests.failed,
            errorRate: latestMetric.errors.rate,
            averageResponseTime: latestMetric.timing.averageResponseTime,
            maxResponseTime: latestMetric.timing.maxResponseTime,
            minResponseTime: latestMetric.timing.minResponseTime,
            throughput: latestMetric.throughput.requestsPerSecond,
            concurrentUsers: { max: maxUsers, average: avgUsers },
            dataTransferred: {
                sent: latestMetric.throughput.bytesPerSecond || 0,
                received: 0,
                total: latestMetric.throughput.bytesPerSecond || 0
            },
            testEfficiency: latestMetric.requests.sent > 0 ?
                (latestMetric.requests.completed / latestMetric.requests.sent) * 100 : 0
        };
    }

    private getLatestPercentile(session: PerformanceReportSession, percentile: number): number {
        const metrics = session.metricsHistory;
        if (metrics.length === 0) return 0;

        const latestMetric = metrics[metrics.length - 1];
        switch (percentile) {
            case 50: return latestMetric.timing.percentile50;
            case 95: return latestMetric.timing.percentile95;
            case 99: return latestMetric.timing.percentile99;
            default: return latestMetric.timing.averageResponseTime;
        }
    }

    private startRealTimeReporting(testId: string): void {
        // TODO: Implement real-time reporting via WebSocket or Server-Sent Events
        CSReporter.debug(`Real-time reporting started for test: ${testId}`);
    }

    private async generateAggregatedMetrics(testId: string): Promise<void> {
        // TODO: Implement metrics aggregation for large datasets
    }

    private async generateRealTimeUpdate(testId: string): Promise<void> {
        // TODO: Generate real-time report updates
    }

    private async generateCriticalAlert(testId: string, violation: ThresholdViolation): Promise<void> {
        // TODO: Generate critical performance alerts
        CSReporter.error(`CRITICAL PERFORMANCE ALERT [${testId}]: ${violation.description}`);
    }

    /**
     * Get real-time metrics for a test
     */
    public getRealTimeMetrics(testId: string): RealTimeMetrics | null {
        const session = this.activeReports.get(testId);
        return session?.realTimeData || null;
    }

    /**
     * Get current report configuration
     */
    public getReportConfig(configName: string = 'default'): PerformanceReportConfig | undefined {
        return this.reportConfigs.get(configName);
    }

    /**
     * Set custom report configuration
     */
    public setReportConfig(configName: string, config: PerformanceReportConfig): void {
        this.reportConfigs.set(configName, config);
    }
}

interface PerformanceReportSession {
    testId: string;
    scenarioConfig: PerformanceScenarioConfig;
    reportConfig: PerformanceReportConfig;
    startTime: number;
    endTime?: number;
    metricsHistory: PerformanceMetrics[];
    thresholdViolations: ThresholdViolation[];
    realTimeData: RealTimeMetrics;
}