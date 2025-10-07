import * as fs from 'fs';
import * as path from 'path';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

export interface TestResult {
    feature: string;
    scenario: string;
    status: 'passed' | 'failed' | 'skipped' | 'pending';
    duration: number;
    startTime: string;
    endTime: string;
    steps: StepResult[];
    tags: string[];
    error?: string;
    screenshots: string[];
    videos: string[];
    consoleLogs: string[];
    networkLogs: any[];
    browserInfo: any;
}

export interface StepResult {
    keyword: string;
    name: string;
    status: 'passed' | 'failed' | 'skipped' | 'pending';
    duration: number;
    error?: string;
    screenshot?: string;
    actionDetails?: ActionDetail[];
    elementInfo?: any;
    apiDetails?: any;
    dbDetails?: any;
}

export interface ActionDetail {
    action: string;
    element: string;
    value?: string;
    timestamp: string;
    duration: number;
    screenshot?: string;
}

export class CSHTMLReporter {
    private config: CSConfigurationManager;
    private results: TestResult[] = [];
    private executionStartTime: Date;
    private executionEndTime: Date | null = null;
    private environment: any;
    private executionSettings: any;

    constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.executionStartTime = new Date();
        this.captureEnvironment();
        this.captureExecutionSettings();
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
            timestamp: new Date().toISOString()
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
            traceEnabled: this.config.getBoolean('BROWSER_TRACE_ENABLED', false)
        };
    }

    public addTestResult(result: TestResult): void {
        this.results.push(result);
    }

    public async generateReport(outputPath: string): Promise<void> {
        this.executionEndTime = new Date();
        
        const reportData = {
            title: `CS Test Automation Report - ${this.config.get('PROJECT')}`,
            environment: this.environment,
            executionSettings: this.executionSettings,
            summary: this.generateSummary(),
            results: this.results,
            executionTime: {
                start: this.executionStartTime.toISOString(),
                end: this.executionEndTime!.toISOString(),
                duration: this.executionEndTime!.getTime() - this.executionStartTime.getTime()
            }
        };

        const html = this.generateHTML(reportData);
        
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

        return {
            total,
            passed,
            failed,
            skipped,
            pending,
            passRate: total > 0 ? ((passed / total) * 100).toFixed(2) : 0,
            totalDuration: this.results.reduce((sum, r) => sum + r.duration, 0)
        };
    }

    private generateHTML(data: any): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${data.title}</title>
    <style>
        :root {
            --cs-primary: #667eea;
            --cs-secondary: #764ba2;
            --cs-success: #10b981;
            --cs-danger: #ef4444;
            --cs-warning: #f59e0b;
            --cs-info: #3b82f6;
            --cs-dark: #1f2937;
            --cs-light: #f9fafb;
            --cs-border: #e5e7eb;
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, var(--cs-primary) 0%, var(--cs-secondary) 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, var(--cs-dark) 0%, #374151 100%);
            color: white;
            padding: 30px;
            position: relative;
        }

        .header::before {
            content: 'CS';
            position: absolute;
            right: 30px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 60px;
            font-weight: bold;
            opacity: 0.1;
        }

        .header h1 {
            font-size: 32px;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 15px;
        }

        .header .subtitle {
            opacity: 0.9;
            font-size: 16px;
        }

        .logo {
            width: 50px;
            height: 50px;
            background: linear-gradient(135deg, var(--cs-primary), var(--cs-secondary));
            border-radius: 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 20px;
        }

        .tabs {
            display: flex;
            background: var(--cs-light);
            border-bottom: 2px solid var(--cs-border);
            position: sticky;
            top: 0;
            z-index: 100;
        }

        .tab {
            flex: 0 0 auto;
            padding: 20px 30px;
            background: none;
            border: none;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            color: var(--cs-dark);
            transition: all 0.3s ease;
            position: relative;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .tab:hover {
            background: white;
        }

        .tab.active {
            background: white;
            color: var(--cs-primary);
        }

        .tab.active::after {
            content: '';
            position: absolute;
            bottom: -2px;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, var(--cs-primary), var(--cs-secondary));
        }

        .tab-icon {
            width: 20px;
            height: 20px;
        }

        .tab-content {
            display: none;
            padding: 30px;
            animation: fadeIn 0.3s ease;
        }

        .tab-content.active {
            display: block;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .summary-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .summary-card {
            background: white;
            border: 2px solid var(--cs-border);
            border-radius: 10px;
            padding: 20px;
            text-align: center;
            transition: all 0.3s ease;
        }

        .summary-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 10px 20px rgba(0, 0, 0, 0.1);
        }

        .summary-card.total {
            border-color: var(--cs-primary);
            background: linear-gradient(135deg, rgba(102, 126, 234, 0.1), rgba(118, 75, 162, 0.1));
        }

        .summary-card.passed {
            border-color: var(--cs-success);
            background: rgba(16, 185, 129, 0.1);
        }

        .summary-card.failed {
            border-color: var(--cs-danger);
            background: rgba(239, 68, 68, 0.1);
        }

        .summary-card.skipped {
            border-color: var(--cs-warning);
            background: rgba(245, 158, 11, 0.1);
        }

        .summary-card .number {
            font-size: 36px;
            font-weight: bold;
            margin-bottom: 5px;
        }

        .summary-card .label {
            font-size: 14px;
            color: #6b7280;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .pass-rate {
            margin: 30px 0;
            background: var(--cs-light);
            border-radius: 10px;
            padding: 20px;
        }

        .pass-rate-bar {
            height: 30px;
            background: var(--cs-border);
            border-radius: 15px;
            overflow: hidden;
            position: relative;
        }

        .pass-rate-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--cs-success), #34d399);
            transition: width 1s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            color: white;
            font-weight: bold;
        }

        .feature-group {
            margin-bottom: 30px;
            border: 2px solid var(--cs-border);
            border-radius: 10px;
            overflow: hidden;
        }

        .feature-header {
            background: linear-gradient(135deg, var(--cs-primary), var(--cs-secondary));
            color: white;
            padding: 15px 20px;
            font-size: 18px;
            font-weight: 600;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .feature-header:hover {
            opacity: 0.9;
        }

        .feature-stats {
            display: flex;
            gap: 15px;
            font-size: 14px;
        }

        .scenario {
            border-bottom: 1px solid var(--cs-border);
            padding: 20px;
            background: white;
            transition: background 0.3s ease;
        }

        .scenario:hover {
            background: var(--cs-light);
        }

        .scenario-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            cursor: pointer;
        }

        .scenario-name {
            font-size: 16px;
            font-weight: 600;
            color: var(--cs-dark);
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .status-badge {
            padding: 4px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
        }

        .status-badge.passed {
            background: var(--cs-success);
            color: white;
        }

        .status-badge.failed {
            background: var(--cs-danger);
            color: white;
        }

        .status-badge.skipped {
            background: var(--cs-warning);
            color: white;
        }

        .status-badge.pending {
            background: var(--cs-info);
            color: white;
        }

        .scenario-details {
            display: none;
            padding-top: 15px;
            border-top: 1px solid var(--cs-border);
        }

        .scenario-details.expanded {
            display: block;
        }

        .steps {
            margin-top: 15px;
        }

        .step {
            display: flex;
            align-items: flex-start;
            gap: 15px;
            padding: 12px;
            margin-bottom: 10px;
            background: var(--cs-light);
            border-radius: 8px;
            border-left: 4px solid var(--cs-border);
            transition: all 0.3s ease;
        }

        .step.passed {
            border-left-color: var(--cs-success);
        }

        .step.failed {
            border-left-color: var(--cs-danger);
            background: rgba(239, 68, 68, 0.05);
        }

        .step-icon {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
            font-size: 14px;
        }

        .step-icon.passed {
            background: var(--cs-success);
            color: white;
        }

        .step-icon.failed {
            background: var(--cs-danger);
            color: white;
        }

        .step-content {
            flex: 1;
        }

        .step-keyword {
            font-weight: 600;
            color: var(--cs-primary);
            margin-right: 8px;
        }

        .step-name {
            color: var(--cs-dark);
        }

        .step-duration {
            font-size: 12px;
            color: #6b7280;
            margin-left: auto;
        }

        .step-error {
            margin-top: 10px;
            padding: 10px;
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid var(--cs-danger);
            border-radius: 6px;
            color: var(--cs-danger);
            font-family: 'Courier New', monospace;
            font-size: 13px;
            white-space: pre-wrap;
        }

        .evidence-section {
            margin-top: 20px;
            padding: 15px;
            background: var(--cs-light);
            border-radius: 8px;
        }

        .evidence-title {
            font-weight: 600;
            color: var(--cs-dark);
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .evidence-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 15px;
            margin-top: 10px;
        }

        .screenshot-thumb {
            border: 2px solid var(--cs-border);
            border-radius: 8px;
            overflow: hidden;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .screenshot-thumb:hover {
            transform: scale(1.05);
            box-shadow: 0 10px 20px rgba(0, 0, 0, 0.2);
        }

        .screenshot-thumb img {
            width: 100%;
            height: 150px;
            object-fit: cover;
        }

        .console-logs {
            background: #1f2937;
            color: #10b981;
            padding: 15px;
            border-radius: 8px;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            max-height: 300px;
            overflow-y: auto;
            white-space: pre-wrap;
        }

        .environment-table {
            width: 100%;
            border-collapse: collapse;
        }

        .environment-table th,
        .environment-table td {
            text-align: left;
            padding: 12px;
            border-bottom: 1px solid var(--cs-border);
        }

        .environment-table th {
            background: var(--cs-light);
            font-weight: 600;
            color: var(--cs-dark);
        }

        .environment-table td {
            color: #4b5563;
        }

        .chart-container {
            margin: 30px 0;
            height: 300px;
            position: relative;
        }

        .timeline {
            display: flex;
            overflow-x: auto;
            padding: 20px 0;
            position: relative;
        }

        .timeline::before {
            content: '';
            position: absolute;
            top: 50%;
            left: 0;
            right: 0;
            height: 2px;
            background: var(--cs-border);
        }

        .timeline-item {
            flex: 0 0 auto;
            padding: 0 20px;
            text-align: center;
            position: relative;
        }

        .timeline-marker {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            margin: 0 auto 10px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: white;
            border: 3px solid var(--cs-border);
            position: relative;
            z-index: 1;
        }

        .timeline-marker.passed {
            border-color: var(--cs-success);
            background: var(--cs-success);
            color: white;
        }

        .timeline-marker.failed {
            border-color: var(--cs-danger);
            background: var(--cs-danger);
            color: white;
        }

        .timeline-content {
            background: white;
            border: 1px solid var(--cs-border);
            border-radius: 8px;
            padding: 10px;
            font-size: 12px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }

        .modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.8);
            z-index: 1000;
            align-items: center;
            justify-content: center;
        }

        .modal.active {
            display: flex;
        }

        .modal-content {
            background: white;
            border-radius: 12px;
            max-width: 90%;
            max-height: 90%;
            overflow: auto;
            position: relative;
        }

        .modal-close {
            position: absolute;
            top: 10px;
            right: 10px;
            width: 30px;
            height: 30px;
            border-radius: 50%;
            background: var(--cs-danger);
            color: white;
            border: none;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 20px;
        }

        .filters {
            display: flex;
            gap: 15px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }

        .filter-group {
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .filter-label {
            font-size: 14px;
            color: var(--cs-dark);
            font-weight: 600;
        }

        .filter-select {
            padding: 8px 12px;
            border: 2px solid var(--cs-border);
            border-radius: 6px;
            font-size: 14px;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .filter-select:focus {
            outline: none;
            border-color: var(--cs-primary);
        }

        .search-box {
            flex: 1;
            min-width: 300px;
            position: relative;
        }

        .search-input {
            width: 100%;
            padding: 10px 40px 10px 15px;
            border: 2px solid var(--cs-border);
            border-radius: 8px;
            font-size: 14px;
            transition: all 0.3s ease;
        }

        .search-input:focus {
            outline: none;
            border-color: var(--cs-primary);
        }

        .search-icon {
            position: absolute;
            right: 12px;
            top: 50%;
            transform: translateY(-50%);
            color: #6b7280;
        }

        @media (max-width: 768px) {
            .container {
                border-radius: 0;
            }

            .tabs {
                overflow-x: auto;
            }

            .summary-cards {
                grid-template-columns: 1fr 1fr;
            }
        }

        @media print {
            .tabs,
            .filters,
            .modal {
                display: none;
            }

            .tab-content {
                display: block !important;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>
                <div class="logo">CS</div>
                ${data.title}
            </h1>
            <div class="subtitle">
                Execution: ${new Date(data.executionTime.start).toLocaleString()} | 
                Duration: ${this.formatDuration(data.executionTime.duration)} |
                Environment: ${data.environment.environment.toUpperCase()}
            </div>
        </div>

        <div class="tabs">
            <button class="tab active" data-tab="summary">
                📊 Summary
            </button>
            <button class="tab" data-tab="features">
                🎯 Features & Scenarios
            </button>
            <button class="tab" data-tab="timeline">
                ⏱️ Timeline
            </button>
            <button class="tab" data-tab="evidence">
                📸 Evidence
            </button>
            <button class="tab" data-tab="console">
                💻 Console Logs
            </button>
            <button class="tab" data-tab="environment">
                🔧 Environment
            </button>
            <button class="tab" data-tab="settings">
                ⚙️ Execution Settings
            </button>
            <button class="tab" data-tab="network">
                🌐 Network
            </button>
        </div>

        <!-- Summary Tab -->
        <div class="tab-content active" id="summary-tab">
            <div class="summary-cards">
                <div class="summary-card total">
                    <div class="number">${data.summary.total}</div>
                    <div class="label">Total Tests</div>
                </div>
                <div class="summary-card passed">
                    <div class="number">${data.summary.passed}</div>
                    <div class="label">Passed</div>
                </div>
                <div class="summary-card failed">
                    <div class="number">${data.summary.failed}</div>
                    <div class="label">Failed</div>
                </div>
                <div class="summary-card skipped">
                    <div class="number">${data.summary.skipped}</div>
                    <div class="label">Skipped</div>
                </div>
            </div>

            <div class="pass-rate">
                <h3 style="margin-bottom: 10px;">Pass Rate</h3>
                <div class="pass-rate-bar">
                    <div class="pass-rate-fill" style="width: ${data.summary.passRate}%">
                        ${data.summary.passRate}%
                    </div>
                </div>
            </div>

            <div class="chart-container">
                <canvas id="chart"></canvas>
            </div>
        </div>

        <!-- Features & Scenarios Tab -->
        <div class="tab-content" id="features-tab">
            <div class="filters">
                <div class="filter-group">
                    <label class="filter-label">Status:</label>
                    <select class="filter-select" id="status-filter">
                        <option value="all">All</option>
                        <option value="passed">Passed</option>
                        <option value="failed">Failed</option>
                        <option value="skipped">Skipped</option>
                    </select>
                </div>
                <div class="search-box">
                    <input type="text" class="search-input" placeholder="Search scenarios..." id="search-input">
                    <span class="search-icon">🔍</span>
                </div>
            </div>

            ${this.generateFeatureGroups(data.results)}
        </div>

        <!-- Timeline Tab -->
        <div class="tab-content" id="timeline-tab">
            <h3>Test Execution Timeline</h3>
            <div class="timeline">
                ${this.generateTimeline(data.results)}
            </div>
        </div>

        <!-- Evidence Tab -->
        <div class="tab-content" id="evidence-tab">
            ${this.generateEvidenceSection(data.results)}
        </div>

        <!-- Console Logs Tab -->
        <div class="tab-content" id="console-tab">
            <h3>Console Output</h3>
            <div class="console-logs">
                ${this.generateConsoleLogs(data.results)}
            </div>
        </div>

        <!-- Environment Tab -->
        <div class="tab-content" id="environment-tab">
            <h3>Environment Configuration</h3>
            <table class="environment-table">
                ${Object.entries(data.environment).map(([key, value]) => `
                    <tr>
                        <th>${this.formatKey(key)}</th>
                        <td>${value}</td>
                    </tr>
                `).join('')}
            </table>
        </div>

        <!-- Execution Settings Tab -->
        <div class="tab-content" id="settings-tab">
            <h3>Execution Settings</h3>
            <table class="environment-table">
                ${Object.entries(data.executionSettings).map(([key, value]) => `
                    <tr>
                        <th>${this.formatKey(key)}</th>
                        <td>${value}</td>
                    </tr>
                `).join('')}
            </table>
        </div>

        <!-- Network Tab -->
        <div class="tab-content" id="network-tab">
            <h3>Network Activity</h3>
            ${this.generateNetworkLogs(data.results)}
        </div>
    </div>

    <!-- Image Modal -->
    <div class="modal" id="image-modal">
        <div class="modal-content">
            <button class="modal-close" onclick="closeModal()">×</button>
            <img id="modal-image" style="width: 100%;">
        </div>
    </div>

    <script>
        // Tab switching
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.dataset.tab;
                
                // Update active tab
                document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                
                // Update active content
                document.querySelectorAll('.tab-content').forEach(content => {
                    content.classList.remove('active');
                });
                document.getElementById(tabName + '-tab').classList.add('active');
            });
        });

        // Scenario expansion
        document.querySelectorAll('.scenario-header').forEach(header => {
            header.addEventListener('click', () => {
                const details = header.nextElementSibling;
                details.classList.toggle('expanded');
            });
        });

        // Feature expansion
        document.querySelectorAll('.feature-header').forEach(header => {
            header.addEventListener('click', () => {
                const scenarios = header.nextElementSibling;
                scenarios.style.display = scenarios.style.display === 'none' ? 'block' : 'none';
            });
        });

        // Search functionality
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                const searchTerm = e.target.value.toLowerCase();
                document.querySelectorAll('.scenario').forEach(scenario => {
                    const text = scenario.textContent.toLowerCase();
                    scenario.style.display = text.includes(searchTerm) ? 'block' : 'none';
                });
            });
        }

        // Status filter
        const statusFilter = document.getElementById('status-filter');
        if (statusFilter) {
            statusFilter.addEventListener('change', (e) => {
                const status = e.target.value;
                document.querySelectorAll('.scenario').forEach(scenario => {
                    if (status === 'all') {
                        scenario.style.display = 'block';
                    } else {
                        const hasStatus = scenario.querySelector('.status-badge.' + status);
                        scenario.style.display = hasStatus ? 'block' : 'none';
                    }
                });
            });
        }

        // Image modal
        function openImageModal(src) {
            document.getElementById('modal-image').src = src;
            document.getElementById('image-modal').classList.add('active');
        }

        function closeModal() {
            document.getElementById('image-modal').classList.remove('active');
        }

        // Chart initialization (if you want to add Chart.js later)
        // You can integrate Chart.js for beautiful charts
    </script>
</body>
</html>`;
    }

    private generateFeatureGroups(results: TestResult[]): string {
        const features = this.groupByFeature(results);
        
        return Object.entries(features).map(([feature, scenarios]) => `
            <div class="feature-group">
                <div class="feature-header">
                    <span>📁 ${feature}</span>
                    <div class="feature-stats">
                        <span>✅ ${scenarios.filter(s => s.status === 'passed').length}</span>
                        <span>❌ ${scenarios.filter(s => s.status === 'failed').length}</span>
                        <span>⏭️ ${scenarios.filter(s => s.status === 'skipped').length}</span>
                    </div>
                </div>
                <div class="scenarios">
                    ${scenarios.map(scenario => this.generateScenario(scenario)).join('')}
                </div>
            </div>
        `).join('');
    }

    private generateScenario(scenario: TestResult): string {
        return `
            <div class="scenario">
                <div class="scenario-header">
                    <div class="scenario-name">
                        ${this.getStatusIcon(scenario.status)}
                        ${scenario.scenario}
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span class="status-badge ${scenario.status}">${scenario.status}</span>
                        <span style="color: #6b7280; font-size: 14px;">${this.formatDuration(scenario.duration)}</span>
                    </div>
                </div>
                <div class="scenario-details">
                    ${scenario.tags.length > 0 ? `
                        <div style="margin-bottom: 10px;">
                            ${scenario.tags.map(tag => `<span style="padding: 2px 8px; background: #e5e7eb; border-radius: 12px; font-size: 12px; margin-right: 5px;">${tag}</span>`).join('')}
                        </div>
                    ` : ''}
                    <div class="steps">
                        ${scenario.steps.map(step => this.generateStep(step)).join('')}
                    </div>
                    ${scenario.error ? `<div class="step-error">${scenario.error}</div>` : ''}
                    ${scenario.screenshots.length > 0 ? this.generateScreenshots(scenario.screenshots) : ''}
                </div>
            </div>
        `;
    }

    private generateStep(step: StepResult): string {
        return `
            <div class="step ${step.status}">
                <div class="step-icon ${step.status}">
                    ${this.getStatusIcon(step.status)}
                </div>
                <div class="step-content">
                    <span class="step-keyword">${step.keyword}</span>
                    <span class="step-name">${step.name}</span>
                    ${step.error ? `<div class="step-error">${step.error}</div>` : ''}
                    ${step.actionDetails ? this.generateActionDetails(step.actionDetails) : ''}
                </div>
                <span class="step-duration">${this.formatDuration(step.duration)}</span>
            </div>
        `;
    }

    private generateActionDetails(actions: ActionDetail[]): string {
        return `
            <div style="margin-top: 10px; padding: 10px; background: #f9fafb; border-radius: 6px;">
                <div style="font-size: 12px; font-weight: 600; margin-bottom: 8px;">Actions:</div>
                ${actions.map(action => `
                    <div style="font-size: 12px; padding: 4px 0; color: #4b5563;">
                        • ${action.action} on ${action.element}${action.value ? ` with value "${action.value}"` : ''}
                        <span style="color: #9ca3af; margin-left: 10px;">${this.formatDuration(action.duration)}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    private generateScreenshots(screenshots: string[]): string {
        return `
            <div class="evidence-section">
                <div class="evidence-title">
                    📸 Screenshots
                </div>
                <div class="evidence-grid">
                    ${screenshots.map(screenshot => `
                        <div class="screenshot-thumb" onclick="openImageModal('${screenshot}')">
                            <img src="${screenshot}" alt="Screenshot">
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    private generateTimeline(results: TestResult[]): string {
        return results.map(result => `
            <div class="timeline-item">
                <div class="timeline-marker ${result.status}">
                    ${this.getStatusIcon(result.status)}
                </div>
                <div class="timeline-content">
                    <div style="font-weight: 600; margin-bottom: 5px;">${result.scenario}</div>
                    <div style="font-size: 11px; color: #6b7280;">
                        ${new Date(result.startTime).toLocaleTimeString()}
                    </div>
                    <div style="font-size: 11px; color: #6b7280;">
                        ${this.formatDuration(result.duration)}
                    </div>
                </div>
            </div>
        `).join('');
    }

    private generateEvidenceSection(results: TestResult[]): string {
        const allScreenshots = results.flatMap(r => r.screenshots);
        const allVideos = results.flatMap(r => r.videos);
        
        return `
            <h3>Test Evidence Collection</h3>
            ${allScreenshots.length > 0 ? `
                <div class="evidence-section">
                    <div class="evidence-title">📸 All Screenshots (${allScreenshots.length})</div>
                    <div class="evidence-grid">
                        ${allScreenshots.map(screenshot => `
                            <div class="screenshot-thumb" onclick="openImageModal('${screenshot}')">
                                <img src="${screenshot}" alt="Screenshot">
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : '<p>No screenshots captured</p>'}
            
            ${allVideos.length > 0 ? `
                <div class="evidence-section">
                    <div class="evidence-title">🎥 Videos (${allVideos.length})</div>
                    ${allVideos.map(video => `
                        <video controls style="width: 100%; max-width: 600px; margin-top: 10px;">
                            <source src="${video}" type="video/mp4">
                        </video>
                    `).join('')}
                </div>
            ` : ''}
        `;
    }

    private generateConsoleLogs(results: TestResult[]): string {
        const logs = results.flatMap(r => r.consoleLogs);
        return logs.length > 0 ? logs.join('\n') : 'No console logs captured';
    }

    private generateNetworkLogs(results: TestResult[]): string {
        const networkLogs = results.flatMap(r => r.networkLogs || []);
        
        if (networkLogs.length === 0) {
            return '<p>No network activity captured</p>';
        }

        return `
            <table class="environment-table">
                <thead>
                    <tr>
                        <th>Method</th>
                        <th>URL</th>
                        <th>Status</th>
                        <th>Duration</th>
                        <th>Size</th>
                    </tr>
                </thead>
                <tbody>
                    ${networkLogs.map(log => `
                        <tr>
                            <td><span style="font-weight: 600; color: ${this.getMethodColor(log.method)}">${log.method}</span></td>
                            <td style="max-width: 400px; overflow: hidden; text-overflow: ellipsis;">${log.url}</td>
                            <td><span class="status-badge ${log.status < 400 ? 'passed' : 'failed'}">${log.status}</span></td>
                            <td>${log.duration}ms</td>
                            <td>${this.formatBytes(log.size)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    private groupByFeature(results: TestResult[]): Record<string, TestResult[]> {
        return results.reduce((acc, result) => {
            if (!acc[result.feature]) {
                acc[result.feature] = [];
            }
            acc[result.feature].push(result);
            return acc;
        }, {} as Record<string, TestResult[]>);
    }

    private getStatusIcon(status: string): string {
        switch (status) {
            case 'passed': return '✅';
            case 'failed': return '❌';
            case 'skipped': return '⏭️';
            case 'pending': return '⏸️';
            default: return '❓';
        }
    }

    private getMethodColor(method: string): string {
        switch (method.toUpperCase()) {
            case 'GET': return '#10b981';
            case 'POST': return '#3b82f6';
            case 'PUT': return '#f59e0b';
            case 'DELETE': return '#ef4444';
            default: return '#6b7280';
        }
    }

    private formatDuration(ms: number): string {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    }

    private formatBytes(bytes: number): string {
        if (!bytes) return '0 B';
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
    }

    private formatKey(key: string): string {
        return key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    }
}