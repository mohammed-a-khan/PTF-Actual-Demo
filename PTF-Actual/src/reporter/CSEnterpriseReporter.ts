import * as fs from 'fs';
import * as path from 'path';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

export interface EnterpriseTestResult {
    id: string;
    feature: string;
    suite: string;
    scenario: string;
    status: 'passed' | 'failed' | 'skipped' | 'pending' | 'broken' | 'flaky';
    severity: 'blocker' | 'critical' | 'major' | 'minor' | 'trivial';
    priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
    duration: number;
    startTime: string;
    endTime: string;
    steps: EnterpriseStepResult[];
    tags: string[];
    categories: string[];
    author: string;
    owner: string;
    epic: string;
    story: string;
    requirement: string;
    error?: ErrorDetail;
    attachments: Attachment[];
    retries: RetryInfo[];
    history: TestHistory[];
    browserInfo: BrowserInfo;
    deviceInfo: DeviceInfo;
    parameters: Record<string, any>;
    links: TestLink[];
    labels: Label[];
    metrics: TestMetrics;
}

export interface EnterpriseStepResult {
    name: string;
    keyword: string;
    status: 'passed' | 'failed' | 'skipped' | 'pending' | 'broken';
    duration: number;
    startTime: string;
    endTime: string;
    error?: ErrorDetail;
    attachments: Attachment[];
    subSteps: EnterpriseStepResult[];
    parameters: Record<string, any>;
    logs: LogEntry[];
}

export interface ErrorDetail {
    message: string;
    stackTrace: string;
    type: string;
    screenshot?: string;
    video?: string;
}

export interface Attachment {
    name: string;
    type: 'screenshot' | 'video' | 'log' | 'har' | 'trace' | 'other';
    path: string;
    timestamp: string;
    size: number;
}

export interface RetryInfo {
    attempt: number;
    status: string;
    duration: number;
    error?: string;
}

export interface TestHistory {
    runId: string;
    date: string;
    status: string;
    duration: number;
}

export interface BrowserInfo {
    name: string;
    version: string;
    platform: string;
    viewport: { width: number; height: number };
}

export interface DeviceInfo {
    type: string;
    model: string;
    os: string;
    osVersion: string;
}

export interface TestLink {
    name: string;
    url: string;
    type: 'issue' | 'requirement' | 'testCase';
}

export interface Label {
    name: string;
    value: string;
}

export interface LogEntry {
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    timestamp: string;
}

export interface TestMetrics {
    cpuUsage: number;
    memoryUsage: number;
    networkRequests: number;
    domElements: number;
    jsErrors: number;
    consoleWarnings: number;
}

export class CSEnterpriseReporter {
    private config: CSConfigurationManager;
    private results: EnterpriseTestResult[] = [];
    private executionStartTime: Date;
    private executionEndTime: Date | null = null;
    private environment: any;
    private executionSettings: any;
    private historicalData: any[] = [];
    private trends: any = {};

    constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.executionStartTime = new Date();
        this.captureEnvironment();
        this.captureExecutionSettings();
        this.loadHistoricalData();
    }

    private captureEnvironment(): void {
        this.environment = {
            project: this.config.get('PROJECT'),
            environment: this.config.get('ENVIRONMENT'),
            baseUrl: this.config.get('BASE_URL'),
            browser: this.config.get('BROWSER'),
            browserVersion: this.config.get('BROWSER_VERSION'),
            viewport: `${this.config.get('BROWSER_VIEWPORT_WIDTH')}x${this.config.get('BROWSER_VIEWPORT_HEIGHT')}`,
            os: process.platform,
            nodeVersion: process.version,
            timestamp: new Date().toISOString(),
            machine: require('os').hostname(),
            cpu: require('os').cpus()[0].model,
            memory: `${Math.round(require('os').totalmem() / 1024 / 1024 / 1024)}GB`,
            user: require('os').userInfo().username
        };
    }

    private captureExecutionSettings(): void {
        this.executionSettings = {
            parallel: this.config.getBoolean('PARALLEL_EXECUTION'),
            workers: this.config.getNumber('PARALLEL_WORKERS'),
            headless: this.config.getBoolean('HEADLESS'),
            slowMo: this.config.getNumber('BROWSER_SLOWMO'),
            timeout: this.config.getNumber('TIMEOUT', 30000),
            retryCount: this.config.getNumber('RETRY_COUNT'),
            videoCapture: this.config.get('BROWSER_VIDEO') !== 'off',
            screenshotOnFail: this.config.getBoolean('SCREENSHOT_ON_FAILURE', true),
            traceEnabled: this.config.getBoolean('BROWSER_TRACE_ENABLED', false),
            networkCapture: this.config.getBoolean('BROWSER_HAR_ENABLED', false),
            consoleCapture: this.config.getBoolean('CONSOLE_LOG_CAPTURE', true)
        };
    }

    private loadHistoricalData(): void {
        const historyPath = path.join(process.cwd(), 'reports', 'history', 'history.json');
        if (fs.existsSync(historyPath)) {
            try {
                this.historicalData = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
            } catch (e) {
                this.historicalData = [];
            }
        }
    }

    private saveHistoricalData(): void {
        const historyDir = path.join(process.cwd(), 'reports', 'history');
        if (!fs.existsSync(historyDir)) {
            fs.mkdirSync(historyDir, { recursive: true });
        }

        const currentRun = {
            runId: Date.now().toString(),
            date: new Date().toISOString(),
            results: this.results.map(r => ({
                id: r.id,
                status: r.status,
                duration: r.duration
            })),
            summary: this.generateSummary()
        };

        this.historicalData.push(currentRun);
        // Keep only last 20 runs
        if (this.historicalData.length > 20) {
            this.historicalData = this.historicalData.slice(-20);
        }

        fs.writeFileSync(
            path.join(historyDir, 'history.json'),
            JSON.stringify(this.historicalData, null, 2)
        );
    }

    public addTestResult(result: EnterpriseTestResult): void {
        this.results.push(result);
    }

    public async generateReport(outputPath: string): Promise<void> {
        this.executionEndTime = new Date();
        this.saveHistoricalData();
        this.calculateTrends();

        const reportData = {
            title: `CS Enterprise Test Report - ${this.config.get('PROJECT')}`,
            environment: this.environment,
            executionSettings: this.executionSettings,
            summary: this.generateSummary(),
            results: this.results,
            executionTime: {
                start: this.executionStartTime.toISOString(),
                end: this.executionEndTime!.toISOString(),
                duration: this.executionEndTime!.getTime() - this.executionStartTime.getTime()
            },
            trends: this.trends,
            history: this.historicalData.slice(-10) // Last 10 runs for display
        };

        const html = this.generateEnterpriseHTML(reportData);
        
        // Ensure directory exists
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(outputPath, html);
    }

    private generateSummary(): any {
        const total = this.results.length;
        const passed = this.results.filter(r => r.status === 'passed').length;
        const failed = this.results.filter(r => r.status === 'failed').length;
        const skipped = this.results.filter(r => r.status === 'skipped').length;
        const pending = this.results.filter(r => r.status === 'pending').length;
        const broken = this.results.filter(r => r.status === 'broken').length;
        const flaky = this.results.filter(r => r.status === 'flaky').length;

        const severityCounts = {
            blocker: this.results.filter(r => r.severity === 'blocker').length,
            critical: this.results.filter(r => r.severity === 'critical').length,
            major: this.results.filter(r => r.severity === 'major').length,
            minor: this.results.filter(r => r.severity === 'minor').length,
            trivial: this.results.filter(r => r.severity === 'trivial').length
        };

        return {
            total,
            passed,
            failed,
            skipped,
            pending,
            broken,
            flaky,
            passRate: total > 0 ? ((passed / total) * 100).toFixed(2) : 0,
            totalDuration: this.results.reduce((sum, r) => sum + r.duration, 0),
            averageDuration: total > 0 ? Math.round(this.results.reduce((sum, r) => sum + r.duration, 0) / total) : 0,
            severityCounts,
            categories: this.getCategorySummary(),
            suites: this.getSuiteSummary()
        };
    }

    private getCategorySummary(): any {
        const categories: Record<string, any> = {};
        this.results.forEach(r => {
            r.categories.forEach(cat => {
                if (!categories[cat]) {
                    categories[cat] = { total: 0, passed: 0, failed: 0 };
                }
                categories[cat].total++;
                if (r.status === 'passed') categories[cat].passed++;
                if (r.status === 'failed') categories[cat].failed++;
            });
        });
        return categories;
    }

    private getSuiteSummary(): any {
        const suites: Record<string, any> = {};
        this.results.forEach(r => {
            if (!suites[r.suite]) {
                suites[r.suite] = { total: 0, passed: 0, failed: 0, duration: 0 };
            }
            suites[r.suite].total++;
            suites[r.suite].duration += r.duration;
            if (r.status === 'passed') suites[r.suite].passed++;
            if (r.status === 'failed') suites[r.suite].failed++;
        });
        return suites;
    }

    private calculateTrends(): void {
        if (this.historicalData.length < 2) return;

        const last10Runs = this.historicalData.slice(-10);
        
        this.trends = {
            passRate: last10Runs.map(run => ({
                date: run.date,
                value: run.summary?.passRate || 0
            })),
            duration: last10Runs.map(run => ({
                date: run.date,
                value: run.summary?.totalDuration || 0
            })),
            testCount: last10Runs.map(run => ({
                date: run.date,
                passed: run.summary?.passed || 0,
                failed: run.summary?.failed || 0,
                skipped: run.summary?.skipped || 0
            }))
        };
    }

    private generateEnterpriseHTML(data: any): string {
        return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${data.title}</title>
    <style>
        ${this.getEnterpriseStyles()}
    </style>
</head>
<body>
    <div class="app-container">
        ${this.generateHeader(data)}
        ${this.generateNavigation()}
        
        <div class="main-content">
            <div class="content-wrapper">
                <!-- Dashboard View -->
                <div id="dashboard-view" class="view-panel active">
                    ${this.generateDashboard(data)}
                </div>

                <!-- Timeline View -->
                <div id="timeline-view" class="view-panel">
                    ${this.generateTimeline(data)}
                </div>

                <!-- Suites View -->
                <div id="suites-view" class="view-panel">
                    ${this.generateSuites(data)}
                </div>

                <!-- Graphs View -->
                <div id="graphs-view" class="view-panel">
                    ${this.generateGraphs(data)}
                </div>

                <!-- Categories View -->
                <div id="categories-view" class="view-panel">
                    ${this.generateCategories(data)}
                </div>

                <!-- Behaviors View -->
                <div id="behaviors-view" class="view-panel">
                    ${this.generateBehaviors(data)}
                </div>

                <!-- Packages View -->
                <div id="packages-view" class="view-panel">
                    ${this.generatePackages(data)}
                </div>

                <!-- History View -->
                <div id="history-view" class="view-panel">
                    ${this.generateHistory(data)}
                </div>

                <!-- Retries View -->
                <div id="retries-view" class="view-panel">
                    ${this.generateRetries(data)}
                </div>

                <!-- Environment View -->
                <div id="environment-view" class="view-panel">
                    ${this.generateEnvironment(data)}
                </div>
            </div>
        </div>
    </div>

    <script>
        ${this.getEnterpriseScripts()}
    </script>
</body>
</html>`;
    }

    private getEnterpriseStyles(): string {
        return `
        :root {
            --primary: #6366f1;
            --primary-dark: #4f46e5;
            --primary-light: #818cf8;
            --secondary: #8b5cf6;
            --success: #10b981;
            --danger: #ef4444;
            --warning: #f59e0b;
            --info: #3b82f6;
            --dark: #1e293b;
            --light: #f8fafc;
            --gray: #64748b;
            --border: #e2e8f0;
            --shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
            --shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
            --radius: 0.5rem;
            --transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: var(--dark);
            line-height: 1.6;
        }

        .app-container {
            display: flex;
            flex-direction: column;
            min-height: 100vh;
            background: white;
        }

        /* Header Styles */
        .header {
            background: linear-gradient(135deg, var(--dark) 0%, #334155 100%);
            color: white;
            padding: 1.5rem 2rem;
            box-shadow: var(--shadow-lg);
            position: relative;
            overflow: hidden;
        }

        .header::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.05'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
        }

        .header-content {
            position: relative;
            z-index: 1;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .header-title {
            display: flex;
            align-items: center;
            gap: 1rem;
        }

        .logo {
            width: 50px;
            height: 50px;
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 24px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        }

        .title-text h1 {
            font-size: 1.875rem;
            font-weight: 700;
            margin-bottom: 0.25rem;
        }

        .title-text p {
            opacity: 0.9;
            font-size: 0.875rem;
        }

        .header-stats {
            display: flex;
            gap: 2rem;
        }

        .stat-item {
            text-align: center;
        }

        .stat-value {
            font-size: 1.5rem;
            font-weight: bold;
        }

        .stat-label {
            font-size: 0.75rem;
            opacity: 0.8;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        /* Navigation */
        .navigation {
            background: var(--light);
            border-bottom: 1px solid var(--border);
            padding: 0 2rem;
            box-shadow: var(--shadow);
            position: sticky;
            top: 0;
            z-index: 100;
        }

        .nav-tabs {
            display: flex;
            gap: 0.5rem;
            overflow-x: auto;
            scrollbar-width: thin;
        }

        .nav-tab {
            padding: 1rem 1.5rem;
            background: none;
            border: none;
            font-size: 0.875rem;
            font-weight: 600;
            color: var(--gray);
            cursor: pointer;
            transition: var(--transition);
            position: relative;
            white-space: nowrap;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .nav-tab:hover {
            color: var(--primary);
            background: rgba(99, 102, 241, 0.05);
        }

        .nav-tab.active {
            color: var(--primary);
        }

        .nav-tab.active::after {
            content: '';
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, var(--primary), var(--secondary));
            border-radius: 3px 3px 0 0;
        }

        .nav-icon {
            width: 18px;
            height: 18px;
        }

        /* Main Content */
        .main-content {
            flex: 1;
            background: #f1f5f9;
        }

        .content-wrapper {
            max-width: 1400px;
            margin: 0 auto;
            padding: 2rem;
        }

        .view-panel {
            display: none;
            animation: fadeIn 0.3s ease;
        }

        .view-panel.active {
            display: block;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* Dashboard Styles */
        .dashboard-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .metric-card {
            background: white;
            border-radius: var(--radius);
            padding: 1.5rem;
            box-shadow: var(--shadow);
            transition: var(--transition);
            border: 1px solid var(--border);
        }

        .metric-card:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-lg);
        }

        .metric-card.primary {
            background: linear-gradient(135deg, var(--primary), var(--primary-dark));
            color: white;
            border: none;
        }

        .metric-card.success {
            background: linear-gradient(135deg, var(--success), #059669);
            color: white;
            border: none;
        }

        .metric-card.danger {
            background: linear-gradient(135deg, var(--danger), #dc2626);
            color: white;
            border: none;
        }

        .metric-card.warning {
            background: linear-gradient(135deg, var(--warning), #d97706);
            color: white;
            border: none;
        }

        .metric-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
        }

        .metric-title {
            font-size: 0.875rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            opacity: 0.9;
        }

        .metric-icon {
            width: 24px;
            height: 24px;
            opacity: 0.8;
        }

        .metric-value {
            font-size: 2.25rem;
            font-weight: bold;
            margin-bottom: 0.5rem;
        }

        .metric-change {
            font-size: 0.875rem;
            display: flex;
            align-items: center;
            gap: 0.25rem;
        }

        .metric-change.positive {
            color: var(--success);
        }

        .metric-change.negative {
            color: var(--danger);
        }

        /* Charts Section */
        .charts-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(500px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .chart-card {
            background: white;
            border-radius: var(--radius);
            padding: 1.5rem;
            box-shadow: var(--shadow);
            border: 1px solid var(--border);
        }

        .chart-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.5rem;
        }

        .chart-title {
            font-size: 1.125rem;
            font-weight: 600;
            color: var(--dark);
        }

        .chart-options {
            display: flex;
            gap: 0.5rem;
        }

        .chart-option {
            padding: 0.25rem 0.75rem;
            border: 1px solid var(--border);
            border-radius: 0.25rem;
            background: white;
            font-size: 0.75rem;
            cursor: pointer;
            transition: var(--transition);
        }

        .chart-option:hover,
        .chart-option.active {
            background: var(--primary);
            color: white;
            border-color: var(--primary);
        }

        .chart-container {
            height: 300px;
            position: relative;
        }

        /* Timeline Styles */
        .timeline-container {
            background: white;
            border-radius: var(--radius);
            padding: 1.5rem;
            box-shadow: var(--shadow);
        }

        .timeline-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1.5rem;
            padding-bottom: 1rem;
            border-bottom: 1px solid var(--border);
        }

        .timeline-controls {
            display: flex;
            gap: 0.5rem;
        }

        .timeline-zoom {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.5rem;
            background: var(--light);
            border-radius: 0.25rem;
        }

        .timeline-body {
            position: relative;
            overflow-x: auto;
            padding: 1rem 0;
        }

        .timeline-track {
            position: relative;
            min-height: 400px;
        }

        .timeline-item {
            position: absolute;
            background: var(--primary);
            border-radius: 0.25rem;
            padding: 0.5rem;
            color: white;
            font-size: 0.75rem;
            cursor: pointer;
            transition: var(--transition);
            overflow: hidden;
        }

        .timeline-item:hover {
            transform: scale(1.02);
            box-shadow: var(--shadow-lg);
            z-index: 10;
        }

        .timeline-item.passed {
            background: var(--success);
        }

        .timeline-item.failed {
            background: var(--danger);
        }

        .timeline-item.skipped {
            background: var(--warning);
        }

        /* Suites & Tests Tree */
        .tree-container {
            background: white;
            border-radius: var(--radius);
            padding: 1.5rem;
            box-shadow: var(--shadow);
        }

        .tree-search {
            margin-bottom: 1.5rem;
        }

        .search-input {
            width: 100%;
            padding: 0.75rem 1rem;
            border: 1px solid var(--border);
            border-radius: var(--radius);
            font-size: 0.875rem;
            transition: var(--transition);
        }

        .search-input:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.1);
        }

        .tree-filters {
            display: flex;
            gap: 0.5rem;
            margin-bottom: 1rem;
            flex-wrap: wrap;
        }

        .filter-chip {
            padding: 0.5rem 1rem;
            background: var(--light);
            border: 1px solid var(--border);
            border-radius: 9999px;
            font-size: 0.875rem;
            cursor: pointer;
            transition: var(--transition);
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .filter-chip:hover {
            background: var(--primary);
            color: white;
            border-color: var(--primary);
        }

        .filter-chip.active {
            background: var(--primary);
            color: white;
            border-color: var(--primary);
        }

        .filter-count {
            background: rgba(255, 255, 255, 0.2);
            padding: 0.125rem 0.5rem;
            border-radius: 9999px;
            font-size: 0.75rem;
        }

        .tree-list {
            list-style: none;
        }

        .tree-item {
            margin-bottom: 0.25rem;
        }

        .tree-node {
            display: flex;
            align-items: center;
            padding: 0.75rem;
            border-radius: 0.25rem;
            cursor: pointer;
            transition: var(--transition);
        }

        .tree-node:hover {
            background: var(--light);
        }

        .tree-node-icon {
            width: 20px;
            height: 20px;
            margin-right: 0.5rem;
            transition: var(--transition);
        }

        .tree-node.expanded .tree-node-icon {
            transform: rotate(90deg);
        }

        .tree-node-content {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .tree-node-title {
            font-weight: 500;
        }

        .tree-node-stats {
            display: flex;
            gap: 0.5rem;
        }

        .tree-stat {
            padding: 0.125rem 0.5rem;
            border-radius: 0.25rem;
            font-size: 0.75rem;
            font-weight: 600;
        }

        .tree-stat.passed {
            background: rgba(16, 185, 129, 0.1);
            color: var(--success);
        }

        .tree-stat.failed {
            background: rgba(239, 68, 68, 0.1);
            color: var(--danger);
        }

        .tree-stat.skipped {
            background: rgba(245, 158, 11, 0.1);
            color: var(--warning);
        }

        .tree-children {
            margin-left: 2rem;
            margin-top: 0.5rem;
            display: none;
        }

        .tree-children.expanded {
            display: block;
        }

        /* Test Details Modal */
        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 1000;
            padding: 2rem;
            overflow-y: auto;
        }

        .modal.active {
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .modal-content {
            background: white;
            border-radius: var(--radius);
            max-width: 1000px;
            width: 100%;
            max-height: 90vh;
            overflow-y: auto;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
        }

        .modal-header {
            padding: 1.5rem;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .modal-title {
            font-size: 1.25rem;
            font-weight: 600;
        }

        .modal-close {
            width: 32px;
            height: 32px;
            border-radius: 0.25rem;
            border: none;
            background: var(--light);
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: var(--transition);
        }

        .modal-close:hover {
            background: var(--danger);
            color: white;
        }

        .modal-body {
            padding: 1.5rem;
        }

        /* History & Trends */
        .trend-chart {
            height: 200px;
            margin-bottom: 1rem;
        }

        .history-table {
            width: 100%;
            border-collapse: collapse;
        }

        .history-table th,
        .history-table td {
            text-align: left;
            padding: 0.75rem;
            border-bottom: 1px solid var(--border);
        }

        .history-table th {
            background: var(--light);
            font-weight: 600;
            font-size: 0.875rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        .history-table tbody tr:hover {
            background: var(--light);
        }

        /* Categories & Tags */
        .category-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 1rem;
        }

        .category-card {
            background: white;
            border-radius: var(--radius);
            padding: 1rem;
            border: 1px solid var(--border);
            transition: var(--transition);
        }

        .category-card:hover {
            transform: translateY(-2px);
            box-shadow: var(--shadow-lg);
        }

        .category-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 1rem;
        }

        .category-name {
            font-weight: 600;
        }

        .category-badge {
            padding: 0.25rem 0.75rem;
            background: var(--primary);
            color: white;
            border-radius: 9999px;
            font-size: 0.75rem;
            font-weight: 600;
        }

        .category-stats {
            display: flex;
            gap: 1rem;
        }

        .category-stat {
            flex: 1;
            text-align: center;
            padding: 0.5rem;
            background: var(--light);
            border-radius: 0.25rem;
        }

        .category-stat-value {
            font-size: 1.25rem;
            font-weight: bold;
        }

        .category-stat-label {
            font-size: 0.75rem;
            color: var(--gray);
            text-transform: uppercase;
        }

        /* Environment Info */
        .env-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 1rem;
        }

        .env-item {
            background: white;
            border-radius: var(--radius);
            padding: 1rem;
            border: 1px solid var(--border);
        }

        .env-label {
            font-size: 0.75rem;
            color: var(--gray);
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-bottom: 0.25rem;
        }

        .env-value {
            font-weight: 600;
            word-break: break-word;
        }

        /* Responsive */
        @media (max-width: 768px) {
            .header-content {
                flex-direction: column;
                gap: 1rem;
            }

            .dashboard-grid {
                grid-template-columns: 1fr;
            }

            .charts-grid {
                grid-template-columns: 1fr;
            }

            .nav-tabs {
                overflow-x: auto;
            }
        }

        /* Dark Mode */
        [data-theme="dark"] {
            --dark: #f8fafc;
            --light: #1e293b;
            --gray: #94a3b8;
            --border: #334155;
            --shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.3);
        }

        [data-theme="dark"] body {
            background: #0f172a;
            color: var(--dark);
        }

        [data-theme="dark"] .app-container {
            background: #0f172a;
        }

        [data-theme="dark"] .metric-card,
        [data-theme="dark"] .chart-card,
        [data-theme="dark"] .timeline-container,
        [data-theme="dark"] .tree-container,
        [data-theme="dark"] .modal-content {
            background: #1e293b;
            border-color: var(--border);
        }
        `;
    }

    private getEnterpriseScripts(): string {
        return `
        // Navigation
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const targetId = tab.dataset.target;
                
                // Update active tab
                document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                
                // Update active view
                document.querySelectorAll('.view-panel').forEach(panel => {
                    panel.classList.remove('active');
                });
                document.getElementById(targetId).classList.add('active');
                
                // Save preference
                localStorage.setItem('activeView', targetId);
            });
        });

        // Restore last active view
        const lastActiveView = localStorage.getItem('activeView');
        if (lastActiveView) {
            document.querySelector(\`[data-target="\${lastActiveView}"]\`)?.click();
        }

        // Tree expansion
        document.querySelectorAll('.tree-node').forEach(node => {
            node.addEventListener('click', (e) => {
                e.stopPropagation();
                const item = node.parentElement;
                const children = item.querySelector('.tree-children');
                
                if (children) {
                    node.classList.toggle('expanded');
                    children.classList.toggle('expanded');
                }
            });
        });

        // Filter functionality
        document.querySelectorAll('.filter-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                chip.classList.toggle('active');
                applyFilters();
            });
        });

        function applyFilters() {
            const activeFilters = Array.from(document.querySelectorAll('.filter-chip.active')).map(f => f.dataset.filter);
            // Filter logic here
        }

        // Search functionality
        const searchInput = document.querySelector('.search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const searchTerm = e.target.value.toLowerCase();
                filterTests(searchTerm);
            });
        }

        function filterTests(term) {
            document.querySelectorAll('.tree-item').forEach(item => {
                const title = item.querySelector('.tree-node-title').textContent.toLowerCase();
                item.style.display = title.includes(term) ? 'block' : 'none';
            });
        }

        // Theme toggle
        function toggleTheme() {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', newTheme);
            localStorage.setItem('theme', newTheme);
        }

        // Restore theme
        const savedTheme = localStorage.getItem('theme') || 'light';
        document.documentElement.setAttribute('data-theme', savedTheme);

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey) {
                switch(e.key) {
                    case 'd': // Dashboard
                        e.preventDefault();
                        document.querySelector('[data-target="dashboard-view"]').click();
                        break;
                    case 't': // Timeline
                        e.preventDefault();
                        document.querySelector('[data-target="timeline-view"]').click();
                        break;
                    case 's': // Suites
                        e.preventDefault();
                        document.querySelector('[data-target="suites-view"]').click();
                        break;
                    case 'g': // Graphs
                        e.preventDefault();
                        document.querySelector('[data-target="graphs-view"]').click();
                        break;
                    case '/': // Search
                        e.preventDefault();
                        document.querySelector('.search-input')?.focus();
                        break;
                }
            }
        });

        // Auto-refresh functionality
        let autoRefreshInterval;
        function startAutoRefresh(seconds = 30) {
            autoRefreshInterval = setInterval(() => {
                location.reload();
            }, seconds * 1000);
        }

        function stopAutoRefresh() {
            clearInterval(autoRefreshInterval);
        }

        // Chart rendering (simplified - in production would use Chart.js or D3.js)
        function renderCharts() {
            // Render pass rate chart
            renderPassRateChart();
            // Render duration trend
            renderDurationTrend();
            // Render severity distribution
            renderSeverityChart();
            // Render timeline
            renderTimeline();
        }

        function renderPassRateChart() {
            const canvas = document.getElementById('pass-rate-chart');
            if (!canvas) return;
            
            // Simplified chart rendering
            const ctx = canvas.getContext('2d');
            // Draw chart...
        }

        function renderDurationTrend() {
            // Render duration trend chart
        }

        function renderSeverityChart() {
            // Render severity distribution
        }

        function renderTimeline() {
            // Render timeline visualization
        }

        // Initialize charts on load
        document.addEventListener('DOMContentLoaded', () => {
            renderCharts();
        });

        // Export functionality
        function exportReport(format) {
            switch(format) {
                case 'pdf':
                    window.print();
                    break;
                case 'json':
                    downloadJSON();
                    break;
                case 'csv':
                    downloadCSV();
                    break;
            }
        }

        function downloadJSON() {
            const data = collectReportData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'test-report.json';
            a.click();
        }

        function downloadCSV() {
            // Convert report data to CSV format
        }

        function collectReportData() {
            // Collect all report data for export
            return {};
        }
        `;
    }

    private generateHeader(data: any): string {
        return `
        <header class="header">
            <div class="header-content">
                <div class="header-title">
                    <div class="logo">CS</div>
                    <div class="title-text">
                        <h1>${data.title}</h1>
                        <p>${data.environment.environment.toUpperCase()} | ${new Date(data.executionTime.start).toLocaleString()}</p>
                    </div>
                </div>
                <div class="header-stats">
                    <div class="stat-item">
                        <div class="stat-value">${data.summary.passRate}%</div>
                        <div class="stat-label">Pass Rate</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${data.summary.total}</div>
                        <div class="stat-label">Total Tests</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">${this.formatDuration(data.executionTime.duration)}</div>
                        <div class="stat-label">Duration</div>
                    </div>
                </div>
            </div>
        </header>`;
    }

    private generateNavigation(): string {
        return `
        <nav class="navigation">
            <div class="nav-tabs">
                <button class="nav-tab active" data-target="dashboard-view">
                    <span class="nav-icon">📊</span>
                    Dashboard
                </button>
                <button class="nav-tab" data-target="timeline-view">
                    <span class="nav-icon">⏱️</span>
                    Timeline
                </button>
                <button class="nav-tab" data-target="suites-view">
                    <span class="nav-icon">📁</span>
                    Suites
                </button>
                <button class="nav-tab" data-target="graphs-view">
                    <span class="nav-icon">📈</span>
                    Graphs
                </button>
                <button class="nav-tab" data-target="categories-view">
                    <span class="nav-icon">🏷️</span>
                    Categories
                </button>
                <button class="nav-tab" data-target="behaviors-view">
                    <span class="nav-icon">🎯</span>
                    Behaviors
                </button>
                <button class="nav-tab" data-target="packages-view">
                    <span class="nav-icon">📦</span>
                    Packages
                </button>
                <button class="nav-tab" data-target="history-view">
                    <span class="nav-icon">📜</span>
                    History
                </button>
                <button class="nav-tab" data-target="retries-view">
                    <span class="nav-icon">🔄</span>
                    Retries
                </button>
                <button class="nav-tab" data-target="environment-view">
                    <span class="nav-icon">🔧</span>
                    Environment
                </button>
            </div>
        </nav>`;
    }

    private generateDashboard(data: any): string {
        return `
        <div class="dashboard-grid">
            <div class="metric-card primary">
                <div class="metric-header">
                    <span class="metric-title">Total Tests</span>
                    <span class="metric-icon">📊</span>
                </div>
                <div class="metric-value">${data.summary.total}</div>
                <div class="metric-change">
                    <span>All test cases executed</span>
                </div>
            </div>

            <div class="metric-card success">
                <div class="metric-header">
                    <span class="metric-title">Passed</span>
                    <span class="metric-icon">✅</span>
                </div>
                <div class="metric-value">${data.summary.passed}</div>
                <div class="metric-change positive">
                    <span>↑ ${data.summary.passRate}% pass rate</span>
                </div>
            </div>

            <div class="metric-card danger">
                <div class="metric-header">
                    <span class="metric-title">Failed</span>
                    <span class="metric-icon">❌</span>
                </div>
                <div class="metric-value">${data.summary.failed}</div>
                <div class="metric-change negative">
                    <span>${data.summary.failed > 0 ? '⚠️ Needs attention' : 'No failures'}</span>
                </div>
            </div>

            <div class="metric-card warning">
                <div class="metric-header">
                    <span class="metric-title">Skipped</span>
                    <span class="metric-icon">⏭️</span>
                </div>
                <div class="metric-value">${data.summary.skipped}</div>
                <div class="metric-change">
                    <span>${data.summary.pending} pending</span>
                </div>
            </div>

            <div class="metric-card">
                <div class="metric-header">
                    <span class="metric-title">Flaky Tests</span>
                    <span class="metric-icon">🔄</span>
                </div>
                <div class="metric-value">${data.summary.flaky || 0}</div>
                <div class="metric-change">
                    <span>Unstable tests</span>
                </div>
            </div>

            <div class="metric-card">
                <div class="metric-header">
                    <span class="metric-title">Avg Duration</span>
                    <span class="metric-icon">⏱️</span>
                </div>
                <div class="metric-value">${this.formatDuration(data.summary.averageDuration)}</div>
                <div class="metric-change">
                    <span>Per test case</span>
                </div>
            </div>
        </div>

        <div class="charts-grid">
            <div class="chart-card">
                <div class="chart-header">
                    <h3 class="chart-title">Test Status Distribution</h3>
                    <div class="chart-options">
                        <button class="chart-option active">Pie</button>
                        <button class="chart-option">Bar</button>
                        <button class="chart-option">Donut</button>
                    </div>
                </div>
                <div class="chart-container">
                    <canvas id="status-chart"></canvas>
                </div>
            </div>

            <div class="chart-card">
                <div class="chart-header">
                    <h3 class="chart-title">Severity Distribution</h3>
                    <div class="chart-options">
                        <button class="chart-option active">All</button>
                        <button class="chart-option">Failed Only</button>
                    </div>
                </div>
                <div class="chart-container">
                    <canvas id="severity-chart"></canvas>
                </div>
            </div>

            <div class="chart-card">
                <div class="chart-header">
                    <h3 class="chart-title">Pass Rate Trend</h3>
                    <div class="chart-options">
                        <button class="chart-option active">7 Days</button>
                        <button class="chart-option">30 Days</button>
                    </div>
                </div>
                <div class="chart-container">
                    <canvas id="trend-chart"></canvas>
                </div>
            </div>

            <div class="chart-card">
                <div class="chart-header">
                    <h3 class="chart-title">Duration Analysis</h3>
                    <div class="chart-options">
                        <button class="chart-option active">By Suite</button>
                        <button class="chart-option">By Category</button>
                    </div>
                </div>
                <div class="chart-container">
                    <canvas id="duration-chart"></canvas>
                </div>
            </div>
        </div>`;
    }

    private generateTimeline(data: any): string {
        return `
        <div class="timeline-container">
            <div class="timeline-header">
                <h2>Test Execution Timeline</h2>
                <div class="timeline-controls">
                    <div class="timeline-zoom">
                        <button onclick="zoomTimeline(0.5)">-</button>
                        <span>100%</span>
                        <button onclick="zoomTimeline(2)">+</button>
                    </div>
                    <button class="chart-option">Group by Suite</button>
                    <button class="chart-option">Group by Thread</button>
                </div>
            </div>
            <div class="timeline-body">
                <div class="timeline-track">
                    ${this.generateTimelineItems(data.results)}
                </div>
            </div>
        </div>`;
    }

    private generateTimelineItems(results: any[]): string {
        // Generate timeline items positioned based on start time and duration
        return results.map((result, index) => `
            <div class="timeline-item ${result.status}" 
                 style="left: ${index * 100}px; width: ${Math.max(80, result.duration / 10)}px; top: ${(index % 5) * 60}px;">
                <div>${result.scenario}</div>
                <div style="font-size: 10px;">${this.formatDuration(result.duration)}</div>
            </div>
        `).join('');
    }

    private generateSuites(data: any): string {
        return `
        <div class="tree-container">
            <div class="tree-search">
                <input type="text" class="search-input" placeholder="Search tests...">
            </div>
            <div class="tree-filters">
                <div class="filter-chip" data-filter="passed">
                    <span>✅ Passed</span>
                    <span class="filter-count">${data.summary.passed}</span>
                </div>
                <div class="filter-chip" data-filter="failed">
                    <span>❌ Failed</span>
                    <span class="filter-count">${data.summary.failed}</span>
                </div>
                <div class="filter-chip" data-filter="skipped">
                    <span>⏭️ Skipped</span>
                    <span class="filter-count">${data.summary.skipped}</span>
                </div>
            </div>
            <ul class="tree-list">
                ${this.generateSuiteTree(data.results)}
            </ul>
        </div>`;
    }

    private generateSuiteTree(results: any[]): string {
        const suites = this.groupBySuite(results);
        return Object.entries(suites).map(([suite, tests]: [string, any]) => `
            <li class="tree-item">
                <div class="tree-node">
                    <span class="tree-node-icon">▶</span>
                    <div class="tree-node-content">
                        <span class="tree-node-title">${suite}</span>
                        <div class="tree-node-stats">
                            <span class="tree-stat passed">${tests.filter((t: any) => t.status === 'passed').length}</span>
                            <span class="tree-stat failed">${tests.filter((t: any) => t.status === 'failed').length}</span>
                            <span class="tree-stat skipped">${tests.filter((t: any) => t.status === 'skipped').length}</span>
                        </div>
                    </div>
                </div>
                <ul class="tree-children">
                    ${tests.map((test: any) => `
                        <li class="tree-item">
                            <div class="tree-node">
                                <div class="tree-node-content">
                                    <span class="tree-node-title">${test.scenario}</span>
                                    <span class="tree-stat ${test.status}">${test.status}</span>
                                </div>
                            </div>
                        </li>
                    `).join('')}
                </ul>
            </li>
        `).join('');
    }

    private groupBySuite(results: any[]): Record<string, any[]> {
        return results.reduce((acc, result) => {
            const suite = result.suite || 'Default Suite';
            if (!acc[suite]) acc[suite] = [];
            acc[suite].push(result);
            return acc;
        }, {} as Record<string, any[]>);
    }

    private generateGraphs(data: any): string {
        return `
        <div class="charts-grid">
            <div class="chart-card">
                <div class="chart-header">
                    <h3 class="chart-title">Historical Pass Rate</h3>
                </div>
                <div class="chart-container">
                    <canvas id="historical-pass-rate"></canvas>
                </div>
            </div>
            <div class="chart-card">
                <div class="chart-header">
                    <h3 class="chart-title">Test Duration Trend</h3>
                </div>
                <div class="chart-container">
                    <canvas id="duration-trend"></canvas>
                </div>
            </div>
            <div class="chart-card">
                <div class="chart-header">
                    <h3 class="chart-title">Category Performance</h3>
                </div>
                <div class="chart-container">
                    <canvas id="category-performance"></canvas>
                </div>
            </div>
            <div class="chart-card">
                <div class="chart-header">
                    <h3 class="chart-title">Flaky Test Analysis</h3>
                </div>
                <div class="chart-container">
                    <canvas id="flaky-analysis"></canvas>
                </div>
            </div>
        </div>`;
    }

    private generateCategories(data: any): string {
        return `
        <div class="category-grid">
            ${Object.entries(data.summary.categories || {}).map(([category, stats]: [string, any]) => `
                <div class="category-card">
                    <div class="category-header">
                        <span class="category-name">${category}</span>
                        <span class="category-badge">${stats.total} tests</span>
                    </div>
                    <div class="category-stats">
                        <div class="category-stat">
                            <div class="category-stat-value" style="color: var(--success)">${stats.passed}</div>
                            <div class="category-stat-label">Passed</div>
                        </div>
                        <div class="category-stat">
                            <div class="category-stat-value" style="color: var(--danger)">${stats.failed}</div>
                            <div class="category-stat-label">Failed</div>
                        </div>
                        <div class="category-stat">
                            <div class="category-stat-value">${((stats.passed / stats.total) * 100).toFixed(0)}%</div>
                            <div class="category-stat-label">Pass Rate</div>
                        </div>
                    </div>
                </div>
            `).join('')}
        </div>`;
    }

    private generateBehaviors(data: any): string {
        return `
        <div class="tree-container">
            <h2>Test Behaviors (Epic > Feature > Story)</h2>
            <ul class="tree-list">
                ${this.generateBehaviorTree(data.results)}
            </ul>
        </div>`;
    }

    private generateBehaviorTree(results: any[]): string {
        // Group by Epic > Feature > Story
        const behaviors = this.groupByBehavior(results);
        return Object.entries(behaviors).map(([epic, features]: [string, any]) => `
            <li class="tree-item">
                <div class="tree-node">
                    <span class="tree-node-icon">▶</span>
                    <div class="tree-node-content">
                        <span class="tree-node-title">📚 ${epic}</span>
                    </div>
                </div>
                <ul class="tree-children">
                    ${Object.entries(features).map(([feature, stories]: [string, any]) => `
                        <li class="tree-item">
                            <div class="tree-node">
                                <span class="tree-node-icon">▶</span>
                                <div class="tree-node-content">
                                    <span class="tree-node-title">🎯 ${feature}</span>
                                </div>
                            </div>
                            <ul class="tree-children">
                                ${Object.entries(stories).map(([story, tests]: [string, any]) => `
                                    <li class="tree-item">
                                        <div class="tree-node">
                                            <div class="tree-node-content">
                                                <span class="tree-node-title">📖 ${story}</span>
                                                <span class="tree-stat">${tests.length} tests</span>
                                            </div>
                                        </div>
                                    </li>
                                `).join('')}
                            </ul>
                        </li>
                    `).join('')}
                </ul>
            </li>
        `).join('');
    }

    private groupByBehavior(results: any[]): any {
        const behaviors: any = {};
        results.forEach(result => {
            const epic = result.epic || 'Default Epic';
            const feature = result.feature || 'Default Feature';
            const story = result.story || 'Default Story';
            
            if (!behaviors[epic]) behaviors[epic] = {};
            if (!behaviors[epic][feature]) behaviors[epic][feature] = {};
            if (!behaviors[epic][feature][story]) behaviors[epic][feature][story] = [];
            
            behaviors[epic][feature][story].push(result);
        });
        return behaviors;
    }

    private generatePackages(data: any): string {
        return `
        <div class="tree-container">
            <h2>Test Organization by Package</h2>
            <ul class="tree-list">
                ${this.generatePackageTree(data.results)}
            </ul>
        </div>`;
    }

    private generatePackageTree(results: any[]): string {
        // Group tests by package/module structure
        return '<li>Package tree visualization here</li>';
    }

    private generateHistory(data: any): string {
        return `
        <div class="chart-card">
            <h2>Test Execution History</h2>
            <div class="trend-chart">
                <canvas id="history-trend"></canvas>
            </div>
            <table class="history-table">
                <thead>
                    <tr>
                        <th>Run ID</th>
                        <th>Date</th>
                        <th>Total</th>
                        <th>Passed</th>
                        <th>Failed</th>
                        <th>Pass Rate</th>
                        <th>Duration</th>
                    </tr>
                </thead>
                <tbody>
                    ${(data.history || []).map((run: any) => `
                        <tr>
                            <td>${run.runId}</td>
                            <td>${new Date(run.date).toLocaleString()}</td>
                            <td>${run.summary?.total || 0}</td>
                            <td style="color: var(--success)">${run.summary?.passed || 0}</td>
                            <td style="color: var(--danger)">${run.summary?.failed || 0}</td>
                            <td>${run.summary?.passRate || 0}%</td>
                            <td>${this.formatDuration(run.summary?.totalDuration || 0)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>`;
    }

    private generateRetries(data: any): string {
        const retriedTests = data.results.filter((r: any) => r.retries && r.retries.length > 0);
        return `
        <div class="tree-container">
            <h2>Test Retries Analysis</h2>
            <div class="metric-card">
                <div class="metric-value">${retriedTests.length}</div>
                <div class="metric-title">Tests with retries</div>
            </div>
            <ul class="tree-list">
                ${retriedTests.map((test: any) => `
                    <li class="tree-item">
                        <div class="tree-node">
                            <div class="tree-node-content">
                                <span class="tree-node-title">${test.scenario}</span>
                                <span class="tree-stat">${test.retries.length} retries</span>
                            </div>
                        </div>
                    </li>
                `).join('')}
            </ul>
        </div>`;
    }

    private generateEnvironment(data: any): string {
        return `
        <div class="env-grid">
            ${Object.entries(data.environment).map(([key, value]) => `
                <div class="env-item">
                    <div class="env-label">${this.formatKey(key)}</div>
                    <div class="env-value">${value}</div>
                </div>
            `).join('')}
        </div>

        <h3 style="margin-top: 2rem;">Execution Settings</h3>
        <div class="env-grid">
            ${Object.entries(data.executionSettings).map(([key, value]) => `
                <div class="env-item">
                    <div class="env-label">${this.formatKey(key)}</div>
                    <div class="env-value">${value}</div>
                </div>
            `).join('')}
        </div>`;
    }

    private formatDuration(ms: number): string {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    }

    private formatKey(key: string): string {
        return key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    }
}