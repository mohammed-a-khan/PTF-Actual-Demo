import * as fs from 'fs';
import * as path from 'path';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from './CSReporter';
import { htmlEscape, attrEscape, jsEscape } from './utils/HtmlSanitizer';
// Lazy load heavy report generators to improve startup performance (saves 35+ seconds)
// CSExcelReportGenerator imports ExcelJS (22+ seconds)
// CSPdfReportGenerator imports PDFKit (15+ seconds)
let CSExcelReportGenerator: any = null;
let CSPdfReportGenerator: any = null;
import { CSAIReportAggregator } from './CSAIReportAggregator';

// Test result types
interface TestStep {
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    duration?: number;
    error?: string;
    logs?: string[];
    screenshot?: string;
    actions?: Array<{
        name: string;
        status: string;
        duration?: number;
        timestamp?: string;
        details?: any;
    }>;
}

interface TestScenario {
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    feature?: string;
    tags?: string[];
    steps: TestStep[];
    duration?: number;
    startTime?: Date;
    endTime?: Date;
}

interface TestSuite {
    name: string;
    scenarios: TestScenario[];
    startTime: Date;
    endTime: Date;
    duration?: number;
    totalScenarios?: number;
    passedScenarios?: number;
    failedScenarios?: number;
    skippedScenarios?: number;
}

interface Artifact {
    name: string;
    path: string;
    size: number;
}

interface Artifacts {
    screenshots: Artifact[];
    videos: Artifact[];
    har: Artifact[];
    traces: Artifact[];
    consoleLogs: Artifact[];
}

interface ExecutionHistory {
    date: string;
    timestamp?: string;  // Added for unique identification
    totalScenarios: number;
    passedScenarios: number;
    failedScenarios: number;
    skippedScenarios: number;
    duration: number;
    passRate: number;
}

export class CSHtmlReportGenerator {
    private static brandColor = '#93186C';
    private static brandColorLight = '#b83395';
    private static brandColorDark = '#6b1150';
    private static config = CSConfigurationManager.getInstance();

    public static async generateReport(suite: TestSuite, outputDir: string): Promise<void> {
        try {
            // Ensure output directory exists
            if (!fs.existsSync(outputDir)) {
                fs.mkdirSync(outputDir, { recursive: true });
            }

            // Save console logs to file
            this.saveConsoleLogs(suite, outputDir);

            // Collect artifacts
            const artifacts = this.collectArtifacts(outputDir);

            // Load and update execution history
            const history = this.loadAndUpdateHistory(suite, outputDir);

            // Read logo and convert to base64 for embedding
            const logoSourcePath = path.join(process.cwd(), 'logo.png');
            let logoBase64 = '';
            if (fs.existsSync(logoSourcePath)) {
                const logoBuffer = fs.readFileSync(logoSourcePath);
                logoBase64 = `data:image/png;base64,${logoBuffer.toString('base64')}`;
                CSReporter.debug(`Logo embedded as base64`);
            }

            // Generate the complete HTML report with embedded logo
            const htmlContent = this.generateCompleteHTML(suite, artifacts, history, logoBase64);

            // Write the report
            const reportPath = path.join(outputDir, 'index.html');
            fs.writeFileSync(reportPath, htmlContent, 'utf8');

            // Generate supporting JSON data
            this.generateSupportingFiles(suite, artifacts, history, outputDir);

            CSReporter.info(`✨ HTML report generated: ${reportPath}`);

            // Auto-open HTML report in browser IMMEDIATELY after generation
            // Conditions to skip auto-open:
            // 1. In suite mode (CS_SUITE_MODE=true) - consolidated report handles it
            // 2. In CI/Pipeline environment - never auto-open in CI
            // 3. AUTO_OPEN_REPORT config is false
            const isSuiteMode = process.env.CS_SUITE_MODE === 'true';
            const isCI = !!(process.env.CI || process.env.TF_BUILD ||
                           process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI ||
                           process.env.BUILD_BUILDID || process.env.GITHUB_ACTIONS ||
                           process.env.JENKINS_URL || process.env.GITLAB_CI);
            const autoOpenReport = this.config.get('AUTO_OPEN_REPORT', 'true').toLowerCase() === 'true';

            if (autoOpenReport && !isSuiteMode && !isCI) {
                this.openReportInBrowser(reportPath);
            } else if (isCI) {
                CSReporter.debug('Auto-open skipped: CI environment detected');
            }

            // Check configuration for report formats
            const generateExcel = this.config.get('GENERATE_EXCEL_REPORT', 'true').toLowerCase() === 'true';
            const generatePdf = this.config.get('GENERATE_PDF_REPORT', 'true').toLowerCase() === 'true';

            // Generate Excel report
            if (generateExcel) {
                try {
                    // Lazy load CSExcelReportGenerator (saves 22+ seconds at startup)
                    if (!CSExcelReportGenerator) {
                        CSExcelReportGenerator = require('./CSExcelReportGenerator').CSExcelReportGenerator;
                    }
                    await CSExcelReportGenerator.generateReport(suite, outputDir);
                } catch (error) {
                    CSReporter.warn(`Excel report generation failed: ${error}`);
                }
            }

            // Generate PDF report
            if (generatePdf) {
                try {
                    // Lazy load CSPdfReportGenerator (saves 15+ seconds at startup)
                    if (!CSPdfReportGenerator) {
                        CSPdfReportGenerator = require('./CSPdfReportGenerator').CSPdfReportGenerator;
                    }
                    await CSPdfReportGenerator.generateReport(reportPath, outputDir);
                } catch (error) {
                    CSReporter.warn(`PDF report generation failed: ${error}`);
                }
            }

            CSReporter.info(`✅ All reports generated successfully`);

        } catch (error) {
            CSReporter.error(`Failed to generate reports: ${error}`);
            throw error;
        }
    }

    /**
     * Open report in default browser (Windows, macOS, Linux)
     */
    private static openReportInBrowser(reportPath: string): void {
        try {
            const { spawn } = require('child_process');
            const normalizedPath = path.resolve(reportPath);

            CSReporter.info(`Opening report in browser: ${normalizedPath}`);

            if (process.platform === 'win32') {
                // Windows: use 'start' command - quote path for spaces
                spawn('cmd.exe', ['/c', 'start', '""', `"${normalizedPath}"`], {
                    detached: true,
                    stdio: 'ignore',
                    shell: true
                }).unref();
            } else if (process.platform === 'darwin') {
                // macOS
                spawn('open', [normalizedPath], { detached: true, stdio: 'ignore' }).unref();
            } else {
                // Linux
                spawn('xdg-open', [normalizedPath], { detached: true, stdio: 'ignore' }).unref();
            }
        } catch (error: any) {
            CSReporter.warn(`Could not auto-open report: ${error.message}`);
        }
    }

    /**
     * Load execution history and update with current run
     */
    private static loadAndUpdateHistory(suite: TestSuite, outputDir: string): ExecutionHistory[] {
        // Get the configured reports base directory from environment/properties
        const reportsBaseDir = this.config.get('REPORTS_BASE_DIR', './reports');
        const historyFile = path.join(reportsBaseDir, 'execution-history.json');
        let history: ExecutionHistory[] = [];

        CSReporter.debug(`Loading execution history from: ${historyFile}`);

        // Load existing history
        try {
            if (fs.existsSync(historyFile)) {
                const data = fs.readFileSync(historyFile, 'utf8');
                history = JSON.parse(data);
                CSReporter.debug(`Loaded ${history.length} history entries`);
            } else {
                CSReporter.debug('No existing history file found, starting fresh');
            }
        } catch (error) {
            CSReporter.warn('Failed to load execution history, starting fresh');
        }

        // Add current execution with timestamp for uniqueness
        const stats = this.calculateStatistics(suite);
        const currentEntry: ExecutionHistory = {
            date: new Date().toISOString().split('T')[0],
            timestamp: new Date().toISOString(),
            totalScenarios: stats.totalScenarios,
            passedScenarios: stats.passedScenarios,
            failedScenarios: stats.failedScenarios,
            skippedScenarios: stats.skippedScenarios,
            duration: suite.duration || 0,
            passRate: parseFloat(stats.passRate)
        };

        // APPEND entry - don't remove existing entries
        history.push(currentEntry);

        // Keep only last 100 entries (for trend analysis)
        history = history.slice(-100);

        // Save updated history
        try {
            // Ensure reports base directory exists
            if (!fs.existsSync(reportsBaseDir)) {
                fs.mkdirSync(reportsBaseDir, { recursive: true });
            }
            fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
            CSReporter.debug(`Saved ${history.length} history entries to: ${historyFile}`);
        } catch (error) {
            CSReporter.warn('Failed to save execution history');
        }

        return history;
    }

    /**
     * Save console logs to a file
     */
    private static saveConsoleLogs(suite: TestSuite, outputDir: string): void {
        const baseDir = path.dirname(outputDir);
        const consoleLogsDir = path.join(baseDir, 'console-logs');

        // Create console-logs directory if it doesn't exist
        if (!fs.existsSync(consoleLogsDir)) {
            fs.mkdirSync(consoleLogsDir, { recursive: true });
        }

        // Collect all logs from scenarios and steps
        let allLogs: string[] = [];
        const timestamp = new Date().toISOString().replace(/[:]/g, '-').split('.')[0];

        suite.scenarios.forEach((scenario, scenarioIndex) => {
            allLogs.push(`\n${'='.repeat(80)}`);
            allLogs.push(`SCENARIO ${scenarioIndex + 1}: ${scenario.name}`);
            allLogs.push(`Status: ${scenario.status}`);
            allLogs.push(`Feature: ${scenario.feature || 'Unknown'}`);
            allLogs.push(`Start Time: ${scenario.startTime || 'N/A'}`);
            allLogs.push(`Duration: ${scenario.duration || 0}ms`);
            allLogs.push(`${'='.repeat(80)}\n`);

            scenario.steps?.forEach((step, stepIndex) => {
                allLogs.push(`  STEP ${stepIndex + 1}: ${step.name}`);
                allLogs.push(`  Status: ${step.status}`);

                if (step.error) {
                    allLogs.push(`  ERROR: ${step.error}`);
                }

                if (step.logs && step.logs.length > 0) {
                    allLogs.push(`  Console Output:`);
                    step.logs.forEach(log => {
                        // Clean ANSI codes
                        const cleanLog = log.replace(/\x1b\[[0-9;]*m/g, '');
                        allLogs.push(`    ${cleanLog}`);
                    });
                }

                if (step.actions && step.actions.length > 0) {
                    allLogs.push(`  Actions:`);
                    step.actions.forEach((action: any) => {
                        allLogs.push(`    - ${action.name} (${action.status})`);
                    });
                }

                allLogs.push('');
            });
        });

        // Add summary at the end
        allLogs.push(`\n${'='.repeat(80)}`);
        allLogs.push('SUMMARY');
        allLogs.push(`${'='.repeat(80)}`);
        allLogs.push(`Total Scenarios: ${suite.scenarios.length}`);
        allLogs.push(`Passed: ${suite.scenarios.filter(s => s.status === 'passed').length}`);
        allLogs.push(`Failed: ${suite.scenarios.filter(s => s.status === 'failed').length}`);
        allLogs.push(`Skipped: ${suite.scenarios.filter(s => s.status === 'skipped').length}`);
        allLogs.push(`Total Duration: ${suite.duration || 0}ms`);
        allLogs.push(`Generated at: ${new Date().toISOString()}`);

        // Save to file
        const logFileName = `console-logs-${timestamp}.txt`;
        const logFilePath = path.join(consoleLogsDir, logFileName);

        fs.writeFileSync(logFilePath, allLogs.join('\n'));
        CSReporter.info(`Console logs saved to: ${logFilePath}`);
    }

    /**
     * Collect artifacts from the output directory
     */
    private static collectArtifacts(outputDir: string): Artifacts {
        const artifacts: Artifacts = {
            screenshots: [],
            videos: [],
            har: [],
            traces: [],
            consoleLogs: []
        };

        const baseDir = path.dirname(outputDir);

        // Define artifact directories
        const artifactDirs = {
            screenshots: path.join(baseDir, 'screenshots'),
            videos: path.join(baseDir, 'videos'),
            har: path.join(baseDir, 'har'),
            traces: path.join(baseDir, 'traces'),
            consoleLogs: path.join(baseDir, 'console-logs')
        };

        // Debug logging
        CSReporter.debug(`Collecting artifacts from baseDir: ${baseDir}`);
        CSReporter.debug(`OutputDir: ${outputDir}`);

        // Collect each type of artifact
        Object.entries(artifactDirs).forEach(([type, dir]) => {
            if (fs.existsSync(dir)) {
                try {
                    const files = fs.readdirSync(dir);
                    CSReporter.debug(`Found ${files.length} ${type} files in ${dir}`);
                    files.forEach(file => {
                        const filePath = path.join(dir, file);
                        const stats = fs.statSync(filePath);
                        const relativePath = path.relative(outputDir, filePath);

                        artifacts[type as keyof Artifacts].push({
                            name: file,
                            path: relativePath,
                            size: stats.size
                        });
                        CSReporter.debug(`Added ${type} artifact: ${file} with path: ${relativePath}`);
                    });
                } catch (error) {
                    CSReporter.warn(`Failed to collect ${type} artifacts from ${dir}: ${error}`);
                }
            } else {
                CSReporter.debug(`${type} directory does not exist: ${dir}`);
            }
        });

        return artifacts;
    }

    /**
     * Calculate comprehensive statistics
     */
    private static calculateStatistics(suite: TestSuite): any {
        let totalSteps = 0;
        let passedSteps = 0;
        let failedSteps = 0;
        let skippedSteps = 0;
        let totalDuration = 0;
        let totalFeatures = 0;
        
        const featureStats = new Map<string, any>();
        const tagStats = new Map<string, number>();
        const performanceMetrics = {
            fastest: [] as any[],
            slowest: [] as any[],
            allScenarios: [] as any[],  // For Speedboard feature (Playwright 1.57 inspired)
            pageLoadTimes: [] as number[],
            responsesTimes: [] as number[]
        };

        const statusDistribution = { passed: 0, failed: 0, skipped: 0 };
        const failureReasons = new Map<string, number>();

        suite.scenarios.forEach(scenario => {
            // Update status distribution
            if (scenario.status === 'passed') statusDistribution.passed++;
            else if (scenario.status === 'failed') statusDistribution.failed++;
            else statusDistribution.skipped++;

            // Track performance
            if (scenario.duration) {
                performanceMetrics.fastest.push({
                    name: scenario.name,
                    duration: scenario.duration
                });
                performanceMetrics.slowest.push({
                    name: scenario.name,
                    duration: scenario.duration
                });
                // Add to allScenarios for Speedboard (Playwright 1.57 inspired)
                performanceMetrics.allScenarios.push({
                    name: scenario.name,
                    duration: scenario.duration,
                    status: scenario.status,
                    feature: scenario.feature || 'Unknown Feature'
                });
            }

            // Analyze failures
            if (scenario.status === 'failed') {
                scenario.steps.forEach(step => {
                    if (step.error) {
                        const reason = this.categorizeFailure(step.error);
                        failureReasons.set(reason, (failureReasons.get(reason) || 0) + 1);
                    }
                });
            }

            // Calculate step statistics
            scenario.steps.forEach(step => {
                totalSteps++;
                if (step.status === 'passed') passedSteps++;
                else if (step.status === 'failed') failedSteps++;
                else skippedSteps++;
                totalDuration += step.duration || 0;
            });

            // Track feature statistics
            const featureName = scenario.feature || 'Unknown Feature';
            if (!featureStats.has(featureName)) {
                featureStats.set(featureName, {
                    name: featureName,
                    passed: 0,
                    failed: 0,
                    skipped: 0,
                    total: 0,
                    duration: 0
                });
                totalFeatures++;
            }
            const fStats = featureStats.get(featureName);
            fStats.total++;
            if (scenario.status === 'passed') fStats.passed++;
            else if (scenario.status === 'failed') fStats.failed++;
            else fStats.skipped++;
            fStats.duration += scenario.duration || 0;

            // Track tag statistics (excluding internal and ADO tags)
            scenario.tags?.filter(tag => !this.shouldExcludeTag(tag)).forEach(tag => {
                tagStats.set(tag, (tagStats.get(tag) || 0) + 1);
            });
        });

        // Sort performance arrays
        performanceMetrics.fastest.sort((a, b) => a.duration - b.duration);
        performanceMetrics.slowest.sort((a, b) => b.duration - a.duration);

        // Calculate metrics with safe division
        const avgScenarioTime = suite.scenarios.length > 0 ? totalDuration / suite.scenarios.length : 0;
        const avgStepTime = totalSteps > 0 ? totalDuration / totalSteps : 0;
        const stepsPerSecond = totalDuration > 0 ? totalSteps / (totalDuration / 1000) : 0;
        const scenarioCount = suite.scenarios.length || 1; // Prevent division by zero

        return {
            totalScenarios: suite.scenarios.length,
            passedScenarios: statusDistribution.passed,
            failedScenarios: statusDistribution.failed,
            skippedScenarios: statusDistribution.skipped,
            totalSteps,
            passedSteps,
            failedSteps,
            skippedSteps,
            totalFeatures,
            totalDuration,
            avgScenarioTime,
            avgStepTime,
            stepsPerSecond,
            averageDuration: avgScenarioTime,
            passRate: ((statusDistribution.passed / scenarioCount) * 100).toFixed(2),
            stabilityScore: ((statusDistribution.passed / scenarioCount) * 100).toFixed(1),
            featureStats: Array.from(featureStats.entries()).map(([name, stats]) => ({ name, ...stats })),
            tagStats: Array.from(tagStats.entries()).map(([tag, count]) => ({ tag, count })),
            statusDistribution,
            performanceMetrics,
            failureReasons: Array.from(failureReasons.entries()).map(([reason, count]) => ({ reason, count }))
        };
    }

    /**
     * Check if a tag should be excluded from charts and statistics
     */
    private static shouldExcludeTag(tag: string): boolean {
        // Exclude internal data configuration tags
        if (tag.startsWith('@data-config:')) return true;

        // Exclude ADO integration tags from charts
        const adoTags = ['@TestPlanId:', '@TestSuiteId:', '@TestCaseId:', '@BuildId:', '@ReleaseId:'];
        if (adoTags.some(adoTag => tag.startsWith(adoTag))) return true;

        // Exclude @DataProvider tag
        if (tag === '@DataProvider') return true;

        return false;
    }

    /**
     * Categorize failure reasons for analysis
     */
    private static categorizeFailure(error: string): string {
        const errorLower = error.toLowerCase();
        
        if (errorLower.includes('timeout') || errorLower.includes('timed out')) {
            return 'Timeout Issues';
        } else if (errorLower.includes('element') || errorLower.includes('locator') || errorLower.includes('not found')) {
            return 'Element Not Found';
        } else if (errorLower.includes('network') || errorLower.includes('connection')) {
            return 'Network Issues';
        } else if (errorLower.includes('assertion') || errorLower.includes('expected')) {
            return 'Assertion Failures';
        } else if (errorLower.includes('permission') || errorLower.includes('access')) {
            return 'Permission Issues';
        } else if (errorLower.includes('javascript') || errorLower.includes('script')) {
            return 'JavaScript Errors';
        } else if (errorLower.includes('page') || errorLower.includes('navigation')) {
            return 'Page Load Issues';
        }
        
        return 'Other Issues';
    }

    /**
     * Get comprehensive environment information
     */
    private static getEnvironmentInfo(suite?: TestSuite): any {
        const os = require('os');
        
        return {
            system: {
                os: `${os.type()} ${os.release()}`,
                osVersion: os.release(),
                platform: process.platform,
                arch: process.arch,
                cpuModel: os.cpus()[0]?.model || 'Unknown',
                cpuCores: os.cpus().length,
                totalMemory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB`,
                freeMemory: `${Math.round(os.freemem() / 1024 / 1024 / 1024)} GB`,
                hostname: os.hostname(),
                user: os.userInfo().username,
                homeDir: os.homedir()
            },
            test: {
                environment: this.config.get('ENVIRONMENT', 'dev'),
                baseUrl: this.config.get('BASE_URL', 'Not configured'),
                apiBaseUrl: this.config.get('API_BASE_URL', 'Not configured'),
                browser: this.config.get('BROWSER', 'chromium'),
                browserVersion: process.env.BROWSER_VERSION || 'Chromium 120+',
                headless: this.config.getBoolean('HEADLESS', true) ? 'Yes' : 'No',
                screenshotMode: this.config.get('SCREENSHOT_CAPTURE_MODE', 'on-failure'),
                videoRecording: this.config.get('BROWSER_VIDEO', 'off') !== 'off' ? 'Enabled' : 'Disabled'
            },
            execution: {
                parallel: this.config.getBoolean('PARALLEL', false) ? 'Enabled' : 'Disabled',
                maxWorkers: this.config.get('WORKERS', '1'),
                timeout: this.config.get('TIMEOUT', '30000') + 'ms',
                networkRecording: this.config.get('HAR_CAPTURE_MODE', 'never') !== 'never' ? 'Enabled' : 'Disabled'
            },
            runtime: {
                nodeVersion: process.version,
                playwrightVersion: require('@playwright/test/package.json').version || '1.40+',
                reportGenerated: new Date().toLocaleString(),
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
            }
        };
    }

    /**
     * Generate the complete HTML report with all enhanced features
     */
    private static generateCompleteHTML(suite: TestSuite, artifacts: Artifacts, history: ExecutionHistory[], logoBase64: string = ''): string {
        const stats = this.calculateStatistics(suite);
        const environment = this.getEnvironmentInfo(suite);
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CS Playwright Test Automation Report</title>
    
    <!-- External Libraries -->
    <!-- Custom Chart Library (embedded) -->
    <script>
${fs.readFileSync(path.join(__dirname, 'CSCustomChartsEmbedded.js'), 'utf8')}
    </script>
    <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/dayjs.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/duration.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.10/plugin/relativeTime.js"></script>
    
    <style>
        ${this.generateEnhancedCSS()}
    </style>
</head>
<body>
    <div id="app">
        ${this.generateEnhancedHeader(suite, stats, logoBase64)}
        ${this.generateNavigation()}
        
        <main class="main-content">
            <!-- Dashboard View -->
            <div id="dashboard-view" class="view active">
                ${this.generateEnhancedDashboard(stats, environment, artifacts, history)}
            </div>
            
            <!-- Tests View -->
            <div id="tests-view" class="view">
                ${this.generateEnhancedTestsView(suite, stats)}
            </div>
            
            <!-- Timeline View -->
            <div id="timeline-view" class="view">
                ${this.generateTimelineView(suite, stats)}
            </div>
            
            <!-- Failure Analysis View -->
            <div id="failure-analysis-view" class="view">
                ${this.generateFailureAnalysisView(suite, stats)}
            </div>
            
            <!-- Categories View -->
            <div id="categories-view" class="view">
                ${this.generateEnhancedCategoriesView(suite, stats)}
            </div>
            
            <!-- Environment View -->
            <div id="environment-view" class="view">
                ${this.generateEnhancedEnvironmentView(environment)}
            </div>
            
            <!-- Artifacts View -->
            <div id="artifacts-view" class="view">
                ${this.generateEnhancedArtifactsView(artifacts)}
            </div>
        </main>
        
        ${this.generateFooter()}
    </div>
    
    <!-- Test Details Modal -->
    <div id="test-modal" class="modal">
        <div class="modal-content">
            <span class="modal-close">&times;</span>
            <div id="modal-body"></div>
        </div>
    </div>
    
    <!-- Screenshot Viewer Modal -->
    <div id="screenshot-modal" class="modal">
        <div class="modal-content modal-large">
            <span class="modal-close">&times;</span>
            <img id="screenshot-img" src="" alt="Screenshot">
        </div>
    </div>
    
    <script>
        ${this.generateEnhancedJavaScript(suite, stats, artifacts, history)}
    </script>
</body>
</html>`;
    }

    /**
     * Generate enhanced CSS styling
     */
    private static generateEnhancedCSS(): string {
        return `
        :root {
            --brand-color: ${this.brandColor};
            --brand-color-light: ${this.brandColorLight};
            --brand-color-dark: ${this.brandColorDark};
            --success-color: #10b981;
            --danger-color: #ef4444;
            --warning-color: #f59e0b;
            --info-color: #3b82f6;
            --background: #ffffff;
            --surface: #f9fafb;
            --surface-hover: #f3f4f6;
            --text-primary: #111827;
            --text-secondary: #6b7280;
            --border: #e5e7eb;
            --shadow: rgba(0, 0, 0, 0.1);
            --shadow-lg: rgba(0, 0, 0, 0.2);
        }

        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
            color: var(--text-primary);
            line-height: 1.6;
            min-height: 100vh;
            font-size: 14px;
        }

        #app {
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }

        /* Enhanced Header Styles */
        .header {
            background: linear-gradient(135deg, var(--brand-color) 0%, var(--brand-color-dark) 100%);
            color: white;
            padding: 0.75rem 2rem;
            box-shadow: 0 4px 20px var(--shadow-lg);
            height: 80px;
            display: flex;
            align-items: center;
        }

        .header-content {
            max-width: 1400px;
            margin: 0 auto;
            width: 100%;
            display: grid;
            grid-template-columns: 200px 1fr 200px;
            align-items: center;
        }

        .header-logo {
            justify-self: start;
        }

        .header-title {
            justify-self: center;
            text-align: center;
        }

        .header-info {
            justify-self: end;
            text-align: right;
        }

        .header h1 {
            font-size: 1.75rem;
            font-weight: 700;
            margin: 0;
        }

        /* Logo now embedded directly in h1 for better visibility */

        .execution-info {
            font-size: 0.85rem;
            opacity: 0.9;
            line-height: 1.4;
        }

        /* Navigation Styles */
        .nav {
            background: white;
            box-shadow: 0 2px 10px var(--shadow);
            position: sticky;
            top: 0;
            z-index: 100;
        }

        .nav-container {
            max-width: 1400px;
            margin: 0 auto;
            display: flex;
            overflow-x: auto;
        }

        .nav-item {
            padding: 1rem 1.5rem;
            cursor: pointer;
            border-bottom: 3px solid transparent;
            font-weight: 500;
            white-space: nowrap;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .nav-item:hover {
            background: var(--surface-hover);
            color: var(--brand-color);
        }

        .nav-item.active {
            border-bottom-color: var(--brand-color);
            color: var(--brand-color);
            background: var(--surface);
        }

        /* Main Content */
        .main-content {
            flex: 1;
            max-width: 1400px;
            margin: 0 auto;
            padding: 2rem;
            width: 100%;
        }

        .view {
            display: none;
            animation: fadeIn 0.3s ease;
        }

        .view.active {
            display: block;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* Dashboard Grid */
        .dashboard-grid {
            display: grid;
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .dashboard-title {
            font-size: 2rem;
            font-weight: 700;
            margin-bottom: 2rem;
            color: var(--text-primary);
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        /* Enhanced Stat Cards */
        .stat-card {
            background: white;
            border-radius: 12px;
            padding: 1.5rem;
            box-shadow: 0 4px 15px var(--shadow);
            transition: transform 0.3s ease, box-shadow 0.3s ease;
            border-left: 4px solid var(--border);
        }

        .stat-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px var(--shadow-lg);
        }

        .stat-card.total { border-left-color: var(--info-color); }
        .stat-card.passed { border-left-color: var(--success-color); }
        .stat-card.failed { border-left-color: var(--danger-color); }
        .stat-card.skipped { border-left-color: var(--warning-color); }
        .stat-card.features { border-left-color: #8b5cf6; }
        .stat-card.scenarios { border-left-color: #06b6d4; }
        .stat-card.steps { border-left-color: #ec4899; }
        .stat-card.time { border-left-color: #14b8a6; }
        .stat-card.stability { border-left-color: #22c55e; }

        .stat-value {
            font-size: 2.5rem;
            font-weight: 700;
            line-height: 1;
        }

        .stat-card.total .stat-value { color: var(--info-color); }
        .stat-card.passed .stat-value { color: var(--success-color); }
        .stat-card.failed .stat-value { color: var(--danger-color); }
        .stat-card.skipped .stat-value { color: var(--warning-color); }
        .stat-card.features .stat-value { color: #8b5cf6; }
        .stat-card.scenarios .stat-value { color: #06b6d4; }
        .stat-card.steps .stat-value { color: #ec4899; }
        .stat-card.time .stat-value { color: #14b8a6; }
        .stat-card.stability .stat-value { color: #22c55e; }

        .stat-label {
            font-size: 0.9rem;
            color: var(--text-secondary);
            font-weight: 500;
            margin-top: 0.5rem;
        }

        /* Charts Grid */
        .charts-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .chart-container {
            background: white;
            border-radius: 12px;
            padding: 1.5rem;
            box-shadow: 0 4px 15px var(--shadow);
            display: flex;
            flex-direction: column;
        }

        .chart-title {
            font-size: 1.2rem;
            font-weight: 600;
            margin-bottom: 1rem;
            color: var(--text-primary);
        }

        .chart-canvas {
            height: 300px !important;
        }

        /* Card Styles */
        .card {
            background: white;
            border-radius: 12px;
            box-shadow: 0 4px 15px var(--shadow);
            overflow: hidden;
            transition: transform 0.3s ease;
        }

        .card:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 25px var(--shadow-lg);
        }

        .card-header {
            background: var(--surface);
            padding: 1.5rem;
            border-bottom: 1px solid var(--border);
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .card-title {
            font-size: 1.2rem;
            font-weight: 600;
            color: var(--text-primary);
        }

        .card-content {
            padding: 1.5rem;
        }

        /* Hierarchical Test View */
        .feature-item {
            background: white;
            border-radius: 12px;
            margin-bottom: 1.5rem;
            box-shadow: 0 4px 15px var(--shadow);
            overflow: hidden;
        }

        .feature-header {
            background: white;
            color: #333;
            border: 1px solid #e5e7eb;
            padding: 1rem 1.5rem;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-weight: 600;
        }

        .feature-scenarios {
            display: none;
            padding: 0;
        }

        .feature-scenarios.expanded {
            display: block;
        }

        .scenario-item {
            border: 1px solid var(--border);
            border-radius: 8px;
            margin-bottom: 1.5rem;
            background: var(--surface);
            box-shadow: 0 2px 8px var(--shadow);
            overflow: hidden;
        }

        .scenario-header {
            padding: 1rem 1.5rem;
            cursor: pointer;
            background: var(--surface);
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-weight: 500;
        }

        .scenario-header:hover {
            background: var(--surface-hover);
        }

        .scenario-steps {
            display: none;
            background: white;
        }

        .scenario-steps.expanded {
            display: block;
        }

        .step-item {
            border-left: 4px solid var(--border);
            margin: 0.5rem 1.5rem;
            background: #fafafa;
            border-radius: 8px;
            overflow: hidden;
        }

        .step-header {
            padding: 1rem;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 0.9rem;
        }

        .step-item.passed { border-left-color: var(--success-color); }
        .step-item.failed { border-left-color: var(--danger-color); }
        .step-item.skipped { border-left-color: var(--warning-color); }

        .step-details {
            display: none;
            background: white;
            border-top: 1px solid var(--border);
        }

        .step-details.expanded {
            display: block;
        }

        .step-tabs {
            display: flex;
            background: var(--surface);
            border-bottom: 1px solid var(--border);
        }

        .step-tab {
            padding: 0.5rem 1rem;
            cursor: pointer;
            border-bottom: 2px solid transparent;
            font-size: 0.8rem;
            font-weight: 500;
        }

        .step-tab:hover {
            background: var(--surface-hover);
        }

        .step-tab.active {
            border-bottom-color: var(--brand-color);
            color: var(--brand-color);
        }

        .step-tab-content {
            padding: 1rem;
        }

        .step-tab-pane {
            display: none;
        }

        .step-tab-pane.active {
            display: block;
        }

        /* Status Badges */
        .status-badge {
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 500;
        }

        .status-badge.passed {
            background: #dcfce7;
            color: #166534;
        }

        .status-badge.failed {
            background: #fecaca;
            color: #991b1b;
        }

        .status-badge.skipped {
            background: #fef3c7;
            color: #92400e;
        }

        /* Actions List */
        .actions-list {
            space-y: 0.5rem;
        }

        .action-item {
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.5rem;
            background: var(--surface);
            border-radius: 6px;
            font-size: 0.85rem;
        }

        .action-status {
            width: 8px;
            height: 8px;
            border-radius: 50%;
        }

        .action-status.pass { background: var(--success-color); }
        .action-status.fail { background: var(--danger-color); }
        .action-status.info { background: var(--info-color); }
        .action-status.warn { background: var(--warning-color); }

        /* Logs Styles */
        .logs-container {
            background: #1f2937;
            color: #f9fafb;
            padding: 1rem;
            border-radius: 8px;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            font-size: 0.8rem;
            max-height: 300px;
            overflow-y: auto;
        }

        .log-entry {
            margin-bottom: 0.25rem;
            padding: 0.25rem;
            border-radius: 4px;
        }

        .log-entry.error {
            background: rgba(239, 68, 68, 0.2);
            border-left: 3px solid #ef4444;
            padding-left: 0.5rem;
        }

        /* Performance Metrics */
        .performance-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .metric-card {
            background: white;
            padding: 1.5rem;
            border-radius: 12px;
            box-shadow: 0 4px 15px var(--shadow);
        }

        .metric-value {
            font-size: 2rem;
            font-weight: 700;
            color: var(--brand-color);
        }

        .metric-label {
            font-size: 0.9rem;
            color: var(--text-secondary);
            margin-top: 0.5rem;
        }

        .metric-target {
            font-size: 0.8rem;
            color: var(--text-secondary);
            font-style: italic;
        }

        /* Tables */
        .data-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 1rem;
        }

        .data-table th,
        .data-table td {
            padding: 0.75rem;
            text-align: left;
            border-bottom: 1px solid var(--border);
        }

        .data-table th {
            background: var(--surface);
            font-weight: 600;
            font-size: 0.9rem;
        }

        .data-table tr:hover {
            background: var(--surface);
        }

        /* Environment Sections */
        .env-section {
            background: white;
            border-radius: 12px;
            padding: 1.5rem;
            margin-bottom: 1.5rem;
            box-shadow: 0 4px 15px var(--shadow);
        }

        .env-section-title {
            font-size: 1.3rem;
            font-weight: 600;
            margin-bottom: 1rem;
            color: var(--text-primary);
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .env-table {
            width: 100%;
        }

        .env-table tr {
            border-bottom: 1px solid var(--border);
        }

        .env-table tr:last-child {
            border-bottom: none;
        }

        .env-table th {
            text-align: left;
            padding: 0.75rem 0;
            font-weight: 600;
            color: var(--text-secondary);
            width: 40%;
        }

        .env-table td {
            padding: 0.75rem 0;
            color: var(--text-primary);
        }

        /* Artifacts */
        .artifacts-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 1.5rem;
        }

        .artifact-list {
            max-height: 300px;
            overflow-y: auto;
        }

        .artifact-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.75rem;
            border-bottom: 1px solid var(--border);
            transition: background-color 0.2s;
        }

        .artifact-item:hover {
            background: var(--surface);
        }

        .artifact-item:last-child {
            border-bottom: none;
        }

        .artifact-name {
            font-weight: 500;
            color: var(--brand-color);
            text-decoration: none;
            word-break: break-all;
        }

        .artifact-name:hover {
            text-decoration: underline;
        }

        .artifact-size {
            font-size: 0.8rem;
            color: var(--text-secondary);
            margin-left: 1rem;
            white-space: nowrap;
        }

        /* Failure Analysis */
        .failure-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 2rem;
            margin-bottom: 2rem;
        }

        .failure-chart {
            background: white;
            padding: 1.5rem;
            border-radius: 12px;
            box-shadow: 0 4px 15px var(--shadow);
        }

        .failure-reasons {
            list-style: none;
        }

        .failure-reason {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.5rem 0;
            border-bottom: 1px solid var(--border);
        }

        .failure-reason:last-child {
            border-bottom: none;
        }

        .reason-count {
            background: var(--danger-color);
            color: white;
            padding: 0.25rem 0.5rem;
            border-radius: 12px;
            font-size: 0.8rem;
            font-weight: 600;
        }

        /* Speedboard Styles - Playwright 1.57 inspired */
        .speedboard-card {
            margin-top: 2rem;
            margin-bottom: 2rem;
        }

        .speedboard-card .card-subtitle {
            font-size: 0.85rem;
            color: var(--text-muted);
            margin-top: 0.25rem;
        }

        .speedboard-stats {
            display: flex;
            gap: 2rem;
            margin-bottom: 1rem;
            flex-wrap: wrap;
        }

        .speedboard-stat {
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        .speedboard-stat .stat-label {
            font-size: 0.75rem;
            color: var(--text-muted);
            text-transform: uppercase;
        }

        .speedboard-stat .stat-value {
            font-size: 1.25rem;
            font-weight: 600;
            color: var(--primary-color);
        }

        .speedboard-legend {
            display: flex;
            gap: 1.5rem;
            margin-bottom: 1rem;
            font-size: 0.85rem;
        }

        .legend-item {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .legend-color {
            width: 12px;
            height: 12px;
            border-radius: 2px;
        }

        .legend-color.speedboard-fast {
            background: var(--success-color);
        }

        .legend-color.speedboard-medium {
            background: var(--warning-color);
        }

        .legend-color.speedboard-slow {
            background: var(--danger-color);
        }

        .speedboard-table {
            width: 100%;
            table-layout: fixed;
        }

        .speedboard-table th {
            text-align: left;
            padding: 0.75rem 0.5rem;
            border-bottom: 2px solid var(--border);
            font-size: 0.85rem;
            font-weight: 600;
        }

        .speedboard-table td {
            padding: 0.5rem;
            border-bottom: 1px solid var(--border);
        }

        .speedboard-rank, .speedboard-rank-header {
            width: 40px;
            min-width: 40px;
            text-align: center;
            font-weight: 600;
            color: var(--text-muted);
        }

        .speedboard-status, .speedboard-status-header {
            width: 50px;
            min-width: 50px;
            text-align: center;
        }

        .speedboard-name, .speedboard-name-header {
            width: auto;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .speedboard-duration, .speedboard-duration-header {
            width: 180px;
            min-width: 180px;
        }

        .speedboard-indicator, .speedboard-indicator-header {
            width: 50px;
            min-width: 50px;
            text-align: center;
        }

        .speedboard-bar-container {
            position: relative;
            height: 24px;
            background: var(--bg-color);
            border-radius: 4px;
            overflow: hidden;
        }

        .speedboard-bar {
            position: absolute;
            left: 0;
            top: 0;
            height: 100%;
            border-radius: 4px;
            transition: width 0.3s ease;
        }

        .speedboard-bar.speedboard-fast {
            background: linear-gradient(90deg, var(--success-color), #5cb85c);
        }

        .speedboard-bar.speedboard-medium {
            background: linear-gradient(90deg, var(--warning-color), #f0ad4e);
        }

        .speedboard-bar.speedboard-slow {
            background: linear-gradient(90deg, var(--danger-color), #d9534f);
        }

        .speedboard-time {
            position: absolute;
            right: 8px;
            top: 50%;
            transform: translateY(-50%);
            font-size: 0.8rem;
            font-weight: 600;
            color: var(--text-color);
        }

        .speedboard-more {
            text-align: center;
            padding: 1rem;
            color: var(--text-muted);
            font-size: 0.85rem;
        }

        tr.speedboard-slow {
            background: rgba(217, 83, 79, 0.05);
        }

        tr.speedboard-medium {
            background: rgba(240, 173, 78, 0.05);
        }

        /* Modal Styles */
        .modal {
            display: none;
            position: fixed;
            z-index: 1000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(4px);
        }

        .modal-content {
            background: white;
            margin: 5% auto;
            padding: 2rem;
            border-radius: 12px;
            width: 80%;
            max-width: 800px;
            max-height: 80vh;
            overflow-y: auto;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
        }

        .modal-large {
            max-width: 90%;
        }

        .modal-close {
            color: var(--text-secondary);
            float: right;
            font-size: 2rem;
            font-weight: bold;
            cursor: pointer;
            line-height: 1;
        }

        .modal-close:hover {
            color: var(--text-primary);
        }

        /* Footer */
        .footer {
            background: var(--surface);
            border-top: 1px solid var(--border);
            padding: 1.5rem 2rem;
            text-align: center;
            color: var(--text-secondary);
            font-size: 0.9rem;
        }

        /* Responsive Design */
        @media (max-width: 768px) {
            .charts-grid {
                grid-template-columns: 1fr;
            }

            .stats-grid {
                grid-template-columns: repeat(2, 1fr);
            }

            .performance-grid {
                grid-template-columns: 1fr;
            }

            .failure-grid {
                grid-template-columns: 1fr;
            }

            .artifacts-grid {
                grid-template-columns: 1fr;
            }

            .main-content {
                padding: 1rem;
            }

            .header {
                padding: 0.5rem 1rem;
                height: auto;
            }

            .header-content {
                grid-template-columns: 1fr;
                gap: 0.5rem;
            }

            .header-logo {
                justify-self: center;
            }

            .header h1 {
                font-size: 1.25rem;
            }

            .header-info {
                display: none;
            }
            
            h1 {
                font-size: 1.5rem !important;
            }
        }

        /* Utility Classes */
        .text-center { text-align: center; }
        .text-right { text-align: right; }
        .text-success { color: var(--success-color); }
        .text-danger { color: var(--danger-color); }
        .text-warning { color: var(--warning-color); }
        .text-info { color: var(--info-color); }
        .text-muted { color: var(--text-secondary); }
        .font-weight-bold { font-weight: 600; }
        .mb-1 { margin-bottom: 0.5rem; }
        .mb-2 { margin-bottom: 1rem; }
        .mb-3 { margin-bottom: 1.5rem; }
        .mb-4 { margin-bottom: 2rem; }

        /* Toggle Icons */
        .toggle-icon {
            transition: transform 0.3s ease;
        }

        .toggle-icon.expanded {
            transform: rotate(90deg);
        }

        /* AI Operations Styles */
        .ai-operations-section {
            margin-bottom: 2rem;
        }

        .ai-stats-container {
            background: white;
            border-radius: 12px;
            padding: 2rem;
            box-shadow: 0 4px 15px var(--shadow);
            margin-bottom: 2rem;
        }

        .ai-stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1.5rem;
            margin-top: 1.5rem;
        }

        .ai-stat-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border-radius: 12px;
            padding: 1.5rem;
            box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
            transition: transform 0.3s ease, box-shadow 0.3s ease;
        }

        .ai-stat-card:hover {
            transform: translateY(-4px);
            box-shadow: 0 8px 25px rgba(102, 126, 234, 0.4);
        }

        .ai-stat-card.success {
            background: linear-gradient(135deg, #10b981 0%, #059669 100%);
            box-shadow: 0 4px 15px rgba(16, 185, 129, 0.3);
        }

        .ai-stat-card.warning {
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
            box-shadow: 0 4px 15px rgba(245, 158, 11, 0.3);
        }

        .ai-stat-card.danger {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
            box-shadow: 0 4px 15px rgba(239, 68, 68, 0.3);
        }

        .ai-stat-value {
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
        }

        .ai-stat-label {
            font-size: 0.9rem;
            opacity: 0.95;
            font-weight: 500;
        }

        .ai-stat-detail {
            font-size: 0.75rem;
            opacity: 0.8;
            margin-top: 0.25rem;
        }

        .ai-section {
            background: white;
            border-radius: 12px;
            padding: 1.5rem;
            box-shadow: 0 2px 10px var(--shadow);
            margin-bottom: 1.5rem;
        }

        .ai-section h3 {
            margin-bottom: 1rem;
            color: var(--brand-color);
        }

        /* AI Strategy Tables */
        .ai-strategy-table,
        .ai-fragile-table,
        .ai-timeline-table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 1rem;
        }

        .ai-strategy-table th,
        .ai-strategy-table td,
        .ai-fragile-table th,
        .ai-fragile-table td,
        .ai-timeline-table th,
        .ai-timeline-table td {
            padding: 0.75rem 1rem;
            text-align: left;
            border-bottom: 1px solid #e5e7eb;
        }

        .ai-strategy-table th,
        .ai-fragile-table th,
        .ai-timeline-table th {
            background-color: #f9fafb;
            font-weight: 600;
            color: #374151;
            border-bottom: 2px solid #d1d5db;
        }

        .ai-strategy-table tr:hover,
        .ai-fragile-table tr:hover,
        .ai-timeline-table tr:hover {
            background-color: #f9fafb;
        }

        .ai-strategy-table td:nth-child(2),
        .ai-strategy-table td:nth-child(3),
        .ai-strategy-table td:nth-child(4),
        .ai-strategy-table td:nth-child(5),
        .ai-fragile-table td:nth-child(3),
        .ai-fragile-table td:nth-child(4) {
            text-align: center;
        }

        .ai-strategy-table th:nth-child(2),
        .ai-strategy-table th:nth-child(3),
        .ai-strategy-table th:nth-child(4),
        .ai-strategy-table th:nth-child(5),
        .ai-fragile-table th:nth-child(3),
        .ai-fragile-table th:nth-child(4) {
            text-align: center;
        }
        `;
    }

    /**
     * Generate enhanced header without stat cards
     */
    private static generateEnhancedHeader(suite: TestSuite, stats: any, logoBase64: string = ''): string {
        const duration = this.formatDuration(suite.duration || 0);
        
        return `
        <header class="header">
            <div class="header-content">
                <div class="header-logo">
                    ${logoBase64 ?
                        `<img src="${logoBase64}" alt="" style="width: 180px; height: 60px; object-fit: contain;">` :
                        `<div style="width: 180px; height: 60px; display: flex; align-items: center; justify-content: center; background: var(--brand-color); color: white; font-size: 24px; font-weight: bold; border-radius: 8px;">CS Framework</div>`
                    }
                </div>
                <div class="header-title">
                    <h1>CS Playwright Test Automation Report</h1>
                </div>
                <div class="header-info execution-info">
                    <div><strong>Started:</strong> ${new Date(suite.startTime).toLocaleString()}</div>
                    <div><strong>Duration:</strong> ${duration}</div>
                </div>
            </div>
        </header>`;
    }

    /**
     * Generate navigation with enhanced tabs
     */
    private static generateNavigation(): string {
        return `
        <nav class="nav">
            <div class="nav-container">
                <div class="nav-item active" data-view="dashboard">
                    📊 Dashboard
                </div>
                <div class="nav-item" data-view="tests">
                    🧪 Tests
                </div>
                <div class="nav-item" data-view="timeline">
                    ⏱️ Timeline
                </div>
                <div class="nav-item" data-view="failure-analysis">
                    🔍 Failure Analysis
                </div>
                <div class="nav-item" data-view="categories">
                    📂 Categories
                </div>
                <div class="nav-item" data-view="environment">
                    ⚙️ Environment
                </div>
                <div class="nav-item" data-view="artifacts">
                    📎 Artifacts
                </div>
            </div>
        </nav>`;
    }

    /**
     * Generate enhanced dashboard with all requested features
     */
    private static generateEnhancedDashboard(stats: any, environment: any, artifacts: Artifacts, history: ExecutionHistory[]): string {
        return `
        <div class="dashboard-title">Test Execution Dashboard</div>
        
        <!-- Statistics Cards -->
        <div class="stats-grid">
            <div class="stat-card total">
                <div class="stat-value">${stats.totalScenarios}</div>
                <div class="stat-label">Total Tests</div>
            </div>
            <div class="stat-card passed">
                <div class="stat-value">${stats.passedScenarios}</div>
                <div class="stat-label">Passed</div>
            </div>
            <div class="stat-card failed">
                <div class="stat-value">${stats.failedScenarios}</div>
                <div class="stat-label">Failed</div>
            </div>
            <div class="stat-card skipped">
                <div class="stat-value">${stats.skippedScenarios}</div>
                <div class="stat-label">Skipped</div>
            </div>
            <div class="stat-card total">
                <div class="stat-value">${stats.passRate}%</div>
                <div class="stat-label">Pass Rate</div>
            </div>
        </div>

        <!-- Charts Grid -->
        <div class="charts-grid">
            <div class="chart-container">
                <div class="chart-title">Test Duration Distribution</div>
                <canvas id="status-chart" class="chart-canvas"></canvas>
            </div>
            <div class="chart-container">
                <div class="chart-title">Test Execution Summary</div>
                <canvas id="heatmap-chart" class="chart-canvas"></canvas>
            </div>
            <div class="chart-container">
                <div class="chart-title">Feature Performance</div>
                <canvas id="feature-chart" class="chart-canvas"></canvas>
            </div>
            <div class="chart-container">
                <div class="chart-title">Execution Trend (Last 7 Days)</div>
                <canvas id="trend-chart" class="chart-canvas"></canvas>
            </div>
        </div>

        <!-- Full Width Charts Row -->
        <div class="charts-grid" style="grid-template-columns: 1fr; margin-top: 1.5rem;">
            <div class="chart-container">
                <div class="chart-title">Tag Distribution</div>
                <canvas id="tag-chart" class="chart-canvas"></canvas>
            </div>
        </div>`;
    }

    /**
     * Generate enhanced tests view with hierarchical structure
     */
    private static generateEnhancedTestsView(suite: TestSuite, stats: any): string {
        // Group scenarios by feature
        const featureGroups = new Map<string, TestScenario[]>();
        suite.scenarios.forEach(scenario => {
            const featureName = scenario.feature || 'Unknown Feature';
            if (!featureGroups.has(featureName)) {
                featureGroups.set(featureName, []);
            }
            featureGroups.get(featureName)!.push(scenario);
        });

        const testMetrics = `
        <div class="stats-grid">
            <div class="stat-card features">
                <div class="stat-value">${stats.totalFeatures}</div>
                <div class="stat-label">Total Features</div>
            </div>
            <div class="stat-card scenarios">
                <div class="stat-value">${stats.totalScenarios}</div>
                <div class="stat-label">Total Scenarios</div>
            </div>
            <div class="stat-card steps">
                <div class="stat-value">${stats.totalSteps}</div>
                <div class="stat-label">No of Steps</div>
            </div>
            <div class="stat-card time">
                <div class="stat-value">${this.formatDuration(stats.avgScenarioTime)}</div>
                <div class="stat-label">Average Execution Time</div>
            </div>
            <div class="stat-card stability">
                <div class="stat-value">${stats.stabilityScore}%</div>
                <div class="stat-label">Stability Score</div>
            </div>
        </div>`;

        const hierarchicalView = Array.from(featureGroups.entries()).map(([featureName, scenarios]) => {
            const scenarioItems = scenarios.map(scenario => `
                <div class="scenario-item">
                    <div class="scenario-header" onclick="toggleScenario(this)">
                        <div>
                            <span class="status-badge ${scenario.status}">${scenario.status}</span>
                            <strong>${htmlEscape(scenario.name)}</strong>
                            <span class="text-muted">(${scenario.steps.length} steps)</span>
                        </div>
                        <div>
                            <span class="text-muted">${this.formatDuration(scenario.duration || 0)}</span>
                            <span class="toggle-icon">▶</span>
                        </div>
                    </div>
                    <div class="scenario-steps">
                        ${(scenario as any).testData ? (() => {
                            const td = (scenario as any).testData;
                            const usedColumns = td.usedColumns || [];
                            const hasUnusedColumns = usedColumns.length < td.totalColumns;
                            const scenarioId = `scenario-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

                            // Get indices of used columns
                            const usedIndices = usedColumns.map((col: string) => td.headers.indexOf(col));

                            // Create filtered data for used columns only
                            const filteredHeaders = usedIndices.map((i: number) => td.headers[i]);
                            const filteredValues = usedIndices.map((i: number) => td.values[i]);

                            return `
                            <div class="test-data-container" style="padding: 10px 15px; background: #f8f9fa; border-left: 3px solid #6c757d; margin: 10px 15px 15px 15px; font-size: 0.9em; border-radius: 4px;">
                                <div style="font-weight: bold; color: #495057; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                                    <div>
                                        📊 Test Data (Iteration ${td.iterationNumber} of ${td.totalIterations})
                                        ${td.source ? `
                                            <span style="font-weight: normal; font-size: 0.9em; color: #6c757d; margin-left: 10px;">
                                                ${td.source.type === 'csv' ?
                                                    `📄 CSV: ${htmlEscape(td.source.file || 'inline')}${td.source.delimiter && td.source.delimiter !== ',' ? ` | Delimiter: "${htmlEscape(td.source.delimiter)}"` : ''}${td.source.filter ? ` | Filter: ${htmlEscape(td.source.filter)}` : ''}` :
                                                  td.source.type === 'excel' || td.source.type === 'xlsx' ?
                                                    `📗 Excel: ${htmlEscape(td.source.file)} | Sheet: ${htmlEscape(td.source.sheet || 'Sheet1')}${td.source.filter ? ` | Filter: ${htmlEscape(td.source.filter)}` : ''}` :
                                                  td.source.type === 'json' ?
                                                    `📋 JSON: ${htmlEscape(td.source.file || 'inline')}${td.source.filter ? ` | Filter: ${htmlEscape(td.source.filter)}` : ''}` :
                                                  td.source.type === 'xml' ?
                                                    `📰 XML: ${htmlEscape(td.source.file || 'inline')}${td.source.filter ? ` | Filter: ${htmlEscape(td.source.filter)}` : ''}` :
                                                  td.source.type === 'database' || td.source.type === 'db' ?
                                                    `🗄️ Database: ${htmlEscape(td.source.connection || 'default')}${td.source.query ? ` | Query: ${htmlEscape(td.source.query)}` : ''}${td.source.filter ? ` | Filter: ${htmlEscape(td.source.filter)}` : ''}` :
                                                  '📝 Inline Examples'}
                                            </span>
                                        ` : ''}
                                    </div>
                                    <div style="font-size: 0.85em;">
                                        ${hasUnusedColumns ? `
                                            <span style="color: #007bff; margin-right: 10px;">
                                                ℹ️ Showing ${usedColumns.length} of ${td.totalColumns} columns
                                            </span>
                                            <button onclick="toggleAllColumns('${scenarioId}')" style="background: #007bff; color: white; border: none; padding: 3px 10px; border-radius: 3px; cursor: pointer; font-size: 0.85em;">
                                                <span id="toggle-btn-${scenarioId}">Show All Columns</span>
                                            </button>
                                        ` : `
                                            <span style="color: #28a745;">
                                                ✓ All ${td.totalColumns} columns used
                                            </span>
                                        `}
                                    </div>
                                </div>

                                <!-- Used columns table (always visible) -->
                                <div id="used-columns-${scenarioId}">
                                    <table style="width: 100%; border-collapse: collapse; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                                        <thead>
                                            <tr style="background: #e9ecef;">
                                                ${filteredHeaders.map((header: string) => `
                                                    <th style="padding: 8px 12px; text-align: left; border: 1px solid #dee2e6; font-weight: 600; background: #d1f2eb;">${htmlEscape(header)} ✓</th>
                                                `).join('')}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr style="background: white;">
                                                ${filteredValues.map((value: string) => `
                                                    <td style="padding: 8px 12px; border: 1px solid #dee2e6; font-family: monospace; font-size: 0.95em;">${htmlEscape(value)}</td>
                                                `).join('')}
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>

                                <!-- All columns table (hidden by default) -->
                                ${hasUnusedColumns ? `
                                <div id="all-columns-${scenarioId}" style="display: none; margin-top: 10px;">
                                    <div style="margin-bottom: 5px; font-size: 0.85em; color: #6c757d;">
                                        <strong>All Available Columns:</strong> (✓ = used in scenario, ✗ = unused)
                                    </div>
                                    <div style="max-height: 400px; overflow-x: auto; overflow-y: auto; border: 1px solid #dee2e6; border-radius: 4px;">
                                        <table style="width: 100%; border-collapse: collapse;">
                                            <thead style="position: sticky; top: 0; background: white; z-index: 10;">
                                                <tr style="background: #e9ecef;">
                                                    ${td.headers.map((header: string, idx: number) => {
                                                        const isUsed = usedColumns.includes(header);
                                                        return `
                                                            <th style="padding: 8px 12px; text-align: left; border: 1px solid #dee2e6; font-weight: 600;
                                                                       background: ${isUsed ? '#d1f2eb' : '#f8f9fa'};
                                                                       color: ${isUsed ? '#155724' : '#6c757d'};
                                                                       white-space: nowrap;">
                                                                ${htmlEscape(header)} ${isUsed ? '✓' : '✗'}
                                                            </th>
                                                        `;
                                                    }).join('')}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                <tr style="background: white;">
                                                    ${td.values.map((value: string, idx: number) => {
                                                        const isUsed = usedColumns.includes(td.headers[idx]);
                                                        return `
                                                            <td style="padding: 8px 12px; border: 1px solid #dee2e6;
                                                                       font-family: monospace; font-size: 0.9em;
                                                                       background: ${isUsed ? '#f6ffed' : 'white'};
                                                                       color: ${isUsed ? '#000' : '#6c757d'};
                                                                       white-space: nowrap;">
                                                                ${htmlEscape(value || '-')}
                                                            </td>
                                                        `;
                                                    }).join('')}
                                                </tr>
                                            </tbody>
                                        </table>
                                    </div>
                                </div>
                                ` : ''}
                            </div>
                            `;
                        })() : ''}
                        ${scenario.steps.map((step, index) => `
                            <div class="step-item ${step.status}">
                                <div class="step-header" onclick="toggleStep(this)">
                                    <div>
                                        <span class="status-badge ${step.status}">${step.status}</span>
                                        <span>${htmlEscape(step.name)}</span>
                                    </div>
                                    <div>
                                        <span class="text-muted">Duration: ${step.duration || 0}ms</span>
                                        <span class="toggle-icon">▶</span>
                                    </div>
                                </div>
                                <div class="step-details">
                                    <div class="step-tabs">
                                        <div class="step-tab active" onclick="showStepTab(this, 'actions-${index}')">Actions</div>
                                        <div class="step-tab" onclick="showStepTab(this, 'screenshots-${index}')">Screenshots</div>
                                        <div class="step-tab" onclick="showStepTab(this, 'error-${index}')">Error Details</div>
                                    </div>
                                    <div class="step-tab-content">
                                        <div class="step-tab-pane active" id="actions-${index}">
                                            <div class="actions-list">
                                                ${this.generateStepActions(step)}
                                            </div>
                                        </div>
                                        <div class="step-tab-pane" id="screenshots-${index}">
                                            ${this.generateStepScreenshots(step)}
                                        </div>
                                        <div class="step-tab-pane" id="error-${index}">
                                            <div class="error-details-container">
                                                ${this.generateStepErrorDetails(step)}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `).join('');

            // Calculate feature-level statistics
            const passedCount = scenarios.filter(s => s.status === 'passed').length;
            const failedCount = scenarios.filter(s => s.status === 'failed').length;
            const skippedCount = scenarios.filter(s => s.status === 'skipped').length;
            const featureStatus = failedCount > 0 ? 'failed' : (skippedCount === scenarios.length ? 'skipped' : 'passed');
            const featureStatusIcon = featureStatus === 'passed' ? '✅' : (featureStatus === 'failed' ? '❌' : '⏭️');

            return `
                <div class="feature-item">
                    <div class="feature-header" onclick="toggleFeature(this)">
                        <div>
                            <strong>${featureStatusIcon} 📁 ${featureName}</strong>
                            <span class="text-muted" style="margin-left: 1rem;">(${scenarios.length} scenarios)</span>
                            <span style="margin-left: 0.5rem;">
                                ${passedCount > 0 ? `<span style="color: #28a745; font-weight: 500;">${passedCount} passed</span>` : ''}
                                ${failedCount > 0 ? `<span style="color: #dc3545; font-weight: 500; margin-left: 0.5rem;">${failedCount} failed</span>` : ''}
                                ${skippedCount > 0 ? `<span style="color: #6c757d; font-weight: 500; margin-left: 0.5rem;">${skippedCount} skipped</span>` : ''}
                            </span>
                        </div>
                        <div>
                            <span class="toggle-icon">▶</span>
                        </div>
                    </div>
                    <div class="feature-scenarios">
                        ${scenarioItems}
                    </div>
                </div>
            `;
        }).join('');

        return testMetrics + hierarchicalView;
    }

    /**
     * Generate step actions for the Actions tab
     */
    private static generateStepActions(step: TestStep): string {
        // Use actions array if available, fallback to logs
        const actions = (step as any).actions || [];
        
        if (actions.length === 0) {
            return '<div class="text-muted">No actions recorded for this step</div>';
        }

        return actions.map((action: any) => {
            const iconMap: any = {
                'click': '🖱️',
                'type': '⌨️',
                'navigate': '🧭',
                'wait': '⏳',
                'assert': '✅',
                'screenshot': '📷'
            };
            
            // Determine action type from the action name
            let actionType = 'info';
            let icon = '▶️';
            
            const actionName = action.name || action.action || '';
            const lowerAction = actionName.toLowerCase();
            
            if (lowerAction.includes('click')) {
                icon = iconMap.click;
            } else if (lowerAction.includes('type') || lowerAction.includes('fill') || lowerAction.includes('enter')) {
                icon = iconMap.type;
            } else if (lowerAction.includes('navigat') || lowerAction.includes('goto')) {
                icon = iconMap.navigate;
            } else if (lowerAction.includes('wait')) {
                icon = iconMap.wait;
            } else if (lowerAction.includes('assert') || lowerAction.includes('expect')) {
                // For assertions, check status first to determine the right icon
                icon = (action.status === 'failed' || action.status === 'fail') ? '❌' : '✅';
            } else if (lowerAction.includes('screenshot')) {
                icon = iconMap.screenshot;
            }

            // Override icon for any failed action
            if (action.status === 'failed' || action.status === 'fail') {
                actionType = 'fail';
                // For non-assertion failures, use ❌
                if (!lowerAction.includes('assert') && !lowerAction.includes('expect')) {
                    icon = '❌';
                }
            } else if (action.status === 'passed' || action.status === 'pass') {
                actionType = 'pass';
            }
            
            // Clean up the action text for better readability
            let displayText = actionName;
            // Remove ANSI color codes
            displayText = displayText.replace(/\x1b\[[0-9;]*m/g, '');
            // Limit length for better display
            if (displayText.length > 150) {
                displayText = displayText.substring(0, 150) + '...';
            }
            
            return `
                <div class="action-item">
                    <span class="action-icon ${actionType}">${icon}</span>
                    <span>${htmlEscape(displayText)}</span>
                </div>
            `;
        }).join('');
    }

    /**
     * Generate step screenshots for the Screenshots tab
     */
    private static generateStepScreenshots(step: TestStep): string {
        // Check for screenshot in the step
        let screenshotPath = step.screenshot;

        // If no direct screenshot property, try to extract from logs
        if (!screenshotPath && step.logs) {
            for (const log of step.logs) {
                const match = log.match(/Step failure screenshot: (.+\.png)/);
                if (match) {
                    screenshotPath = match[1];
                    break;
                }
            }
        }
        
        if (screenshotPath) {
            // Handle different path formats
            if (screenshotPath.startsWith('./')) {
                screenshotPath = screenshotPath.substring(2);
            }
            
            // Fix screenshot path to be relative to report location (reports/test-results-xxx/reports/index.html)
            // Screenshots are in ../screenshots/ relative to the HTML file
            if (screenshotPath.includes('screenshots/')) {
                const screenshotFile = screenshotPath.substring(screenshotPath.lastIndexOf('/') + 1);
                screenshotPath = `../screenshots/${screenshotFile}`;
            } else if (screenshotPath.includes('reports/test-results-')) {
                // Handle full path
                const parts = screenshotPath.split('/');
                const screenshotIndex = parts.indexOf('screenshots');
                if (screenshotIndex >= 0 && screenshotIndex < parts.length - 1) {
                    screenshotPath = `../screenshots/${parts[parts.length - 1]}`;
                }
            } else if (!screenshotPath.startsWith('../')) {
                screenshotPath = `../screenshots/${path.basename(screenshotPath)}`;
            }
            
            return `
                <div class="text-center">
                    <div style="margin-bottom: 0.5rem; color: var(--text-secondary); font-size: 0.9rem;">
                        ${step.status === 'failed' ? '📸 Failure Screenshot' : '📸 Step Screenshot'}
                    </div>
                    <img src="${screenshotPath}" alt="Step Screenshot" 
                         style="max-width: 100%; border-radius: 8px; box-shadow: 0 4px 15px var(--shadow); cursor: pointer;" 
                         onclick="showScreenshotModal('${screenshotPath}')" 
                         onerror="this.onerror=null; this.src='data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'200\' height=\'150\' viewBox=\'0 0 200 150\'%3E%3Crect width=\'200\' height=\'150\' fill=\'%23f0f0f0\'/%3E%3Ctext x=\'50%25\' y=\'50%25\' text-anchor=\'middle\' dy=\'.3em\' fill=\'%23999\' font-family=\'Arial\' font-size=\'14\'%3EScreenshot not found%3C/text%3E%3C/svg%3E';">
                </div>
            `;
        } else {
            // No screenshot available
            return '<div class="text-muted text-center" style="padding: 2rem; color: #9ca3af;">No screenshot available for this step</div>';
        }
    }

    /**
     * Generate step logs for the Logs tab
     */
    private static generateStepLogs(step: TestStep): string {
        let logs = '';
        
        // Show error with stack trace if available
        if (step.error) {
            // Clean up error message
            let errorMsg = step.error;
            // Remove ANSI color codes
            errorMsg = errorMsg.replace(/\x1b\[[0-9;]*m/g, '');
            // Escape HTML first to prevent XSS
            errorMsg = htmlEscape(errorMsg);
            // Format multi-line errors better (safe after escaping)
            errorMsg = errorMsg.replace(/\n/g, '<br>');

            logs += `<div class="log-entry error">
                <strong>❌ Error:</strong><br>
                <pre style="white-space: pre-wrap; word-wrap: break-word; margin: 0.5rem 0;">${errorMsg}</pre>
            </div>`;
        }
        
        // Show console logs if available
        if (step.logs && step.logs.length > 0) {
            const filteredLogs = step.logs.filter(log => {
                // Filter out duplicate info that's already in actions
                const lower = log.toLowerCase();
                return !lower.includes('[info] click') && 
                       !lower.includes('[info] type') && 
                       !lower.includes('[info] navigate');
            });
            
            if (filteredLogs.length > 0) {
                logs += '<div style="margin-top: 1rem;"><strong>Console Output:</strong></div>';
                logs += filteredLogs.map(log => {
                    // Clean up log text
                    let cleanLog = log.replace(/\x1b\[[0-9;]*m/g, '');
                    
                    const isError = cleanLog.toLowerCase().includes('[error]');
                    const isWarn = cleanLog.toLowerCase().includes('[warn]');
                    const isInfo = cleanLog.toLowerCase().includes('[info]');
                    
                    let className = '';
                    if (isError) className = 'error';
                    else if (isWarn) className = 'warn';
                    else if (isInfo) className = 'info';
                    
                    return `<div class="log-entry ${className}">${htmlEscape(cleanLog)}</div>`;
                }).join('');
            }
        }

        return logs || '<div class="text-muted">No logs or errors for this step</div>';
    }

    /**
     * Generate error details for the Error Details tab
     */
    private static generateStepErrorDetails(step: TestStep): string {
        // Only show content if the step failed
        if (step.status !== 'failed') {
            return '<div class="text-muted text-center" style="padding: 2rem; color: #9ca3af;">No errors for this step</div>';
        }

        let errorContent = '';

        // Show main error message
        if (step.error) {
            // Clean up error message
            let errorMsg = step.error;
            // Remove ANSI color codes
            errorMsg = errorMsg.replace(/\x1b\[[0-9;]*m/g, '');

            // Try to parse error for better formatting
            const errorLines = errorMsg.split('\n');
            let mainError = '';
            let stackTrace = '';
            let isStackTrace = false;

            errorLines.forEach(line => {
                if (line.includes('    at ') || line.includes('      at ') || isStackTrace) {
                    isStackTrace = true;
                    stackTrace += line + '\n';
                } else if (line.trim()) {
                    mainError += line + '\n';
                }
            });

            errorContent += `
                <div class="error-details-section">
                    <div class="error-header">
                        <span class="error-icon">❌</span>
                        <span class="error-title">Error Message</span>
                    </div>
                    <div class="error-message">
                        <pre style="white-space: pre-wrap; word-wrap: break-word; margin: 0; padding: 1rem; background: #fef2f2; border: 1px solid #fecaca; border-radius: 4px; color: #991b1b;">${htmlEscape(mainError.trim())}</pre>
                    </div>
                </div>
            `;

            // Show stack trace if available
            if (stackTrace) {
                errorContent += `
                    <div class="error-details-section" style="margin-top: 1rem;">
                        <div class="error-header">
                            <span class="error-icon">📋</span>
                            <span class="error-title">Stack Trace</span>
                        </div>
                        <div class="stack-trace">
                            <pre style="white-space: pre-wrap; word-wrap: break-word; margin: 0; padding: 1rem; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 4px; font-size: 0.85rem; color: #6b7280; max-height: 400px; overflow-y: auto;">${htmlEscape(stackTrace.trim())}</pre>
                        </div>
                    </div>
                `;
            }
        }

        // Extract error-related logs
        if (step.logs && step.logs.length > 0) {
            const errorLogs = step.logs.filter(log => {
                const lower = log.toLowerCase();
                return lower.includes('error') || lower.includes('fail') || lower.includes('exception') || lower.includes('trace');
            });

            if (errorLogs.length > 0) {
                errorContent += `
                    <div class="error-details-section" style="margin-top: 1rem;">
                        <div class="error-header">
                            <span class="error-icon">📝</span>
                            <span class="error-title">Error Logs</span>
                        </div>
                        <div class="error-logs">
                `;

                errorLogs.forEach(log => {
                    const cleanLog = log.replace(/\x1b\[[0-9;]*m/g, '');
                    errorContent += `<div class="log-entry error" style="padding: 0.5rem; margin: 0.25rem 0; background: #fef2f2; border-left: 3px solid #ef4444;">${cleanLog}</div>`;
                });

                errorContent += `
                        </div>
                    </div>
                `;
            }
        }

        // Add CSS for error details
        if (!errorContent) {
            return '<div class="text-muted text-center" style="padding: 2rem; color: #9ca3af;">No error details available</div>';
        }

        return `
            <style>
                .error-details-section { margin-bottom: 1.5rem; }
                .error-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; font-weight: 600; color: #374151; }
                .error-icon { font-size: 1.25rem; }
                .error-title { font-size: 1rem; }
            </style>
            ${errorContent}
        `;
    }

    /**
     * Get action type based on log content
     */
    private static getActionType(log: string): string {
        const logLower = log.toLowerCase();
        if (logLower.includes('pass')) return 'pass';
        if (logLower.includes('fail') || logLower.includes('error')) return 'fail';
        if (logLower.includes('warn')) return 'warn';
        return 'info';
    }

    /**
     * Generate Timeline view for test execution timeline
     */
    private static generateTimelineView(suite: TestSuite, stats: any): string {
        // Calculate timeline data
        const scenarios = suite.scenarios || [];
        const startTime = suite.startTime ? new Date(suite.startTime).getTime() : Date.now();

        // Group scenarios by actual worker ID
        const workerMap = new Map<number, any[]>();

        scenarios.forEach((scenario: any, index) => {
            const scenarioStart = scenario.startTime ? new Date(scenario.startTime).getTime() : startTime + (index * 1000);
            const scenarioEnd = scenario.endTime ? new Date(scenario.endTime).getTime() : scenarioStart + (scenario.duration || 1000);

            // Use actual workerId if available, otherwise assign based on overlap
            const workerId = scenario.workerId || 1;

            if (!workerMap.has(workerId)) {
                workerMap.set(workerId, []);
            }

            workerMap.get(workerId)!.push({
                name: scenario.name,
                feature: scenario.feature || 'Unknown',
                status: scenario.status,
                startTime: scenarioStart,
                endTime: scenarioEnd,
                duration: scenario.duration || (scenarioEnd - scenarioStart),
                workerId: workerId
            });
        });

        // Convert map to array for display (sorted by worker ID)
        // Also store the worker IDs for proper labeling
        const workerEntries = Array.from(workerMap.entries())
            .sort((a, b) => a[0] - b[0]);
        const threads = workerEntries.map(entry => entry[1]);
        const workerIds = workerEntries.map(entry => entry[0]);
        
        // Generate timeline visualization
        const timelineHTML = `
        <div class="timeline-container">
            <h2>📊 Execution Timeline</h2>
            <div class="timeline-info">
                <div class="timeline-stat">
                    <span class="stat-label">Total Workers:</span>
                    <span class="stat-value">${threads.length}</span>
                </div>
                <div class="timeline-stat">
                    <span class="stat-label">Parallel Execution:</span>
                    <span class="stat-value">${threads.length > 1 ? 'Yes' : 'No'}</span>
                </div>
                <div class="timeline-stat">
                    <span class="stat-label">Total Duration:</span>
                    <span class="stat-value">${this.formatDuration(stats.totalDuration)}</span>
                </div>
            </div>
            
            <div class="timeline-chart-container">
                <canvas id="timeline-gantt-chart" width="1200" height="400" style="width: 100%; max-width: 1200px;"></canvas>
            </div>
            
            <div class="timeline-legend">
                <div class="legend-item">
                    <span class="legend-color passed"></span> Passed
                </div>
                <div class="legend-item">
                    <span class="legend-color failed"></span> Failed
                </div>
                <div class="legend-item">
                    <span class="legend-color skipped"></span> Skipped
                </div>
            </div>
            
            <div class="timeline-details">
                <h3>Worker Details</h3>
                ${threads.map((thread, threadIndex) => `
                    <div class="thread-details">
                        <h4>Worker ${threadIndex + 1}</h4>
                        <div class="thread-scenarios">
                            ${thread.map((scenario: any) => `
                                <div class="timeline-scenario ${scenario.status}">
                                    <div class="scenario-name">${htmlEscape(scenario.name)}</div>
                                    <div class="scenario-time">
                                        ${new Date(scenario.startTime).toLocaleTimeString()} - 
                                        ${new Date(scenario.endTime).toLocaleTimeString()}
                                        (${this.formatDuration(scenario.duration)})
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
        
        <style>
            .timeline-container {
                padding: 2rem;
            }
            
            .timeline-info {
                display: flex;
                gap: 2rem;
                margin: 2rem 0;
                padding: 1rem;
                background: var(--surface);
                border-radius: 8px;
            }
            
            .timeline-stat {
                display: flex;
                align-items: center;
                gap: 0.5rem;
            }
            
            .timeline-stat .stat-label {
                color: var(--text-secondary);
                font-weight: 500;
            }
            
            .timeline-stat .stat-value {
                color: var(--brand-color);
                font-weight: 700;
                font-size: 1.2rem;
            }
            
            .timeline-chart-container {
                background: white;
                border: 1px solid var(--border);
                border-radius: 12px;
                padding: 2rem;
                margin: 2rem 0;
                overflow-x: auto;
            }
            
            .timeline-legend {
                display: flex;
                gap: 2rem;
                justify-content: center;
                margin: 2rem 0;
            }
            
            .legend-item {
                display: flex;
                align-items: center;
                gap: 0.5rem;
            }
            
            .legend-color {
                width: 20px;
                height: 20px;
                border-radius: 4px;
            }
            
            .legend-color.passed { background: var(--success-color); }
            .legend-color.failed { background: var(--danger-color); }
            .legend-color.skipped { background: var(--warning-color); }
            
            .timeline-details {
                margin-top: 2rem;
            }
            
            .thread-details {
                background: var(--surface);
                border-radius: 8px;
                padding: 1.5rem;
                margin-bottom: 1.5rem;
            }
            
            .thread-details h4 {
                color: var(--brand-color);
                margin-bottom: 1rem;
            }
            
            .thread-scenarios {
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
            }
            
            .timeline-scenario {
                padding: 0.75rem;
                border-radius: 6px;
                border-left: 4px solid;
                background: white;
            }
            
            .timeline-scenario.passed { border-left-color: var(--success-color); }
            .timeline-scenario.failed { border-left-color: var(--danger-color); }
            .timeline-scenario.skipped { border-left-color: var(--warning-color); }
            
            .scenario-name {
                font-weight: 600;
                margin-bottom: 0.25rem;
            }
            
            .scenario-time {
                font-size: 0.85rem;
                color: var(--text-secondary);
            }
        </style>
        
        <script>
            // Initialize timeline Gantt chart when the view is shown
            setTimeout(() => {
                const timelineData = ${JSON.stringify(threads)};
                const workerIds = ${JSON.stringify(workerIds)};
                if (typeof initializeTimelineGantt === 'function') {
                    initializeTimelineGantt(timelineData, workerIds);
                }

                // Initialize Scatter Plot Chart
                const scatterCanvas = document.getElementById('scatter-chart');
                if (scatterCanvas && typeof CSChart !== 'undefined') {
                    const scatterData = [];
                    const scatterLabels = [];
                    timelineData.forEach((thread) => {
                        thread.forEach((scenario) => {
                            scatterData.push(scenario.duration || 0);
                            scatterData.push(scenario.startTime || 0);
                            scatterLabels.push(scenario.name.substring(0, 20));
                        });
                    });

                    new CSChart(scatterCanvas, {
                        type: 'scatter',
                        data: {
                            labels: scatterLabels,
                            datasets: [{
                                data: scatterData,
                                backgroundColor: timelineData.reduce((acc, thread) => {
                                    thread.forEach(s => {
                                        acc.push(s.status === 'passed' ? 'rgb(34, 197, 94)' :
                                                s.status === 'failed' ? 'rgb(239, 68, 68)' : 'rgb(250, 204, 21)');
                                    });
                                    return acc;
                                }, [])
                            }]
                        },
                        options: {
                            plugins: {
                                legend: { display: false }
                            }
                        }
                    });
                }
            }, 100);
            
            // Re-initialize when timeline tab is clicked
            document.addEventListener('DOMContentLoaded', () => {
                const timelineTab = document.querySelector('[data-view="timeline"]');
                if (timelineTab) {
                    timelineTab.addEventListener('click', () => {
                        setTimeout(() => {
                            const timelineData = ${JSON.stringify(threads)};
                            const workerIds = ${JSON.stringify(workerIds)};
                            if (typeof initializeTimelineGantt === 'function') {
                                initializeTimelineGantt(timelineData, workerIds);
                            }
                        }, 100);
                    });
                }
            });
        </script>
        `;
        
        return timelineHTML;
    }

    /**
     * Generate comprehensive failure analysis view
     */
    private static generateFailureAnalysisView(suite: TestSuite, stats: any): string {
        // Get test results from CSReporter to access AI data
        const testResults = CSReporter.getResults();

        // Aggregate AI data and generate AI sections
        let aiSectionsHTML = '';
        if (testResults && testResults.length > 0) {
            const aiAggregator = CSAIReportAggregator.getInstance();
            const aiSummary = aiAggregator.aggregateAIData(testResults);

            // Generate AI statistics HTML if there are AI operations
            if (aiSummary.totalOperations > 0) {
                aiSectionsHTML = aiAggregator.generateAIStatsHTML(aiSummary);
            }
        }

        const performanceMetrics = `
        <div class="performance-grid">
            <div class="metric-card">
                <div class="metric-value">3838ms</div>
                <div class="metric-label">Page Load Time</div>
                <div class="metric-target">Target: < 1000ms</div>
            </div>
            <div class="metric-card">
                <div class="metric-value">1919ms</div>
                <div class="metric-label">Response Time</div>
                <div class="metric-target">Target: < 200ms</div>
            </div>
            <div class="metric-card">
                <div class="metric-value">960ms</div>
                <div class="metric-label">Network Latency</div>
                <div class="metric-target">Target: < 50ms</div>
            </div>
        </div>`;

        const failureReasons = stats.failureReasons && stats.failureReasons.length > 0 ? `
        <div class="failure-grid">
            <div class="failure-chart">
                <h3>Failure Categories</h3>
                <canvas id="failure-categories-chart" style="width: 100%; height: 400px; max-width: 600px; margin: 0 auto; display: block;"></canvas>
            </div>
            <div class="failure-chart">
                <h3>Common Failure Reasons</h3>
                <ul class="failure-reasons">
                    ${stats.failureReasons.map((reason: any) => `
                        <li class="failure-reason">
                            <span>${reason.reason}</span>
                            <span class="reason-count">${reason.count}</span>
                        </li>
                    `).join('')}
                </ul>
            </div>
        </div>` : '<div class="info-message">No failures to analyze</div>';

        // Enhanced Speedboard-style performance tables (Playwright 1.57 inspired)
        const performanceTables = stats.performanceMetrics && stats.performanceMetrics.fastest && stats.performanceMetrics.slowest ? `
        <div class="failure-grid">
            <div class="card">
                <div class="card-header">
                    <div class="card-title">🚀 Fastest Scenarios</div>
                </div>
                <div class="card-content">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Scenario</th>
                                <th>Duration</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${stats.performanceMetrics.fastest.slice(0, 5).map((item: any) => `
                                <tr>
                                    <td>${item.name}</td>
                                    <td>${this.formatDuration(item.duration)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
            <div class="card">
                <div class="card-header">
                    <div class="card-title">🐌 Slowest Scenarios</div>
                </div>
                <div class="card-content">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Scenario</th>
                                <th>Duration</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${stats.performanceMetrics.slowest.slice(0, 5).map((item: any) => `
                                <tr>
                                    <td>${item.name}</td>
                                    <td>${this.formatDuration(item.duration)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>

        ${this.generateSpeedboard(stats)}

        ` : '<div class="info-message">Performance metrics will be available after running tests</div>';

        const performanceSummary = `
        <div class="card">
            <div class="card-header">
                <div class="card-title">📊 Performance Summary</div>
            </div>
            <div class="card-content">
                <div class="stats-grid">
                    <div class="metric-card">
                        <div class="metric-value">${this.formatDuration(stats.avgScenarioTime || 0)}</div>
                        <div class="metric-label">Avg Scenario Time</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value">${this.formatDuration(stats.avgStepTime || 0)}</div>
                        <div class="metric-label">Avg Step Time</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value">${stats.totalSteps || 0}</div>
                        <div class="metric-label">Total Steps</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-value">${(stats.stepsPerSecond || 0).toFixed(2)}</div>
                        <div class="metric-label">Steps/Second</div>
                    </div>
                </div>
            </div>
        </div>`;

        return `
        <h2>Failure Analysis & Performance Metrics</h2>

        ${aiSectionsHTML ? `
        <div class="ai-operations-section">
            <h3>🤖 AI Operations & Intelligent Analysis</h3>
            ${aiSectionsHTML}
        </div>
        ` : ''}

        ${performanceMetrics}
        ${failureReasons}
        ${performanceTables}
        ${performanceSummary}
        `;
    }

    /**
     * Generate enhanced categories view
     */
    private static generateEnhancedCategoriesView(suite: TestSuite, stats: any): string {
        return `
        <h2>Test Categories & Analysis</h2>
        
        <div class="dashboard-grid">
            <div class="card">
                <div class="card-header">
                    <div class="card-title">📊 Feature Distribution</div>
                </div>
                <div class="card-content">
                    <canvas id="feature-distribution-chart" style="width: 100%; height: 400px; max-width: 600px; margin: 0 auto; display: block;"></canvas>
                </div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <div class="card-title">🏷️ Tag Analysis</div>
                </div>
                <div class="card-content">
                    ${stats.tagStats && stats.tagStats.length > 0 ? `
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th>Tag</th>
                                <th>Count</th>
                                <th>Percentage</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${stats.tagStats.map((tag: any) => `
                                <tr>
                                    <td><span class="status-badge">${tag.tag}</span></td>
                                    <td>${tag.count}</td>
                                    <td>${((tag.count / stats.totalScenarios) * 100).toFixed(1)}%</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                    ` : '<div class="info-message">No tags found in test scenarios</div>'}
                </div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <div class="card-title">🎯 Test Coverage</div>
                </div>
                <div class="card-content">
                    <div class="stats-grid">
                        <div class="metric-card">
                            <div class="metric-value">${stats.totalFeatures}</div>
                            <div class="metric-label">Features Covered</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-value">${stats.totalScenarios}</div>
                            <div class="metric-label">Test Scenarios</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-value">${stats.totalSteps}</div>
                            <div class="metric-label">Test Steps</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-value">${stats.passRate}%</div>
                            <div class="metric-label">Coverage Rate</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <div class="card-title">📈 Quality Metrics</div>
                </div>
                <div class="card-content">
                    <div class="stats-grid">
                        <div class="metric-card">
                            <div class="metric-value text-success">${stats.stabilityScore}%</div>
                            <div class="metric-label">Stability Score</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-value text-info">${stats.passRate}%</div>
                            <div class="metric-label">Pass Rate</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-value text-warning">${((stats.failedScenarios / stats.totalScenarios) * 100).toFixed(1)}%</div>
                            <div class="metric-label">Failure Rate</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-value text-info">${this.formatDuration(stats.avgScenarioTime)}</div>
                            <div class="metric-label">Avg Duration</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
    }

    /**
     * Generate enhanced environment view with beautiful categorization
     */
    private static generateEnhancedEnvironmentView(environment: any): string {
        return `
        <h2>Environment Details</h2>
        
        <div class="env-section">
            <div class="env-section-title">
                💻 System Information
            </div>
            <table class="env-table">
                <tr><th>Operating System:</th><td>${environment.system.os}</td></tr>
                <tr><th>OS Version:</th><td>${environment.system.osVersion}</td></tr>
                <tr><th>Platform:</th><td>${environment.system.platform}</td></tr>
                <tr><th>CPU Architecture:</th><td>${environment.system.arch}</td></tr>
                <tr><th>CPU Model:</th><td>${environment.system.cpuModel}</td></tr>
                <tr><th>CPU Cores:</th><td>${environment.system.cpuCores}</td></tr>
                <tr><th>Total Memory:</th><td>${environment.system.totalMemory}</td></tr>
                <tr><th>Free Memory:</th><td>${environment.system.freeMemory}</td></tr>
            </table>
        </div>

        <div class="env-section">
            <div class="env-section-title">
                🧪 Test Configuration
            </div>
            <table class="env-table">
                <tr><th>Test Environment:</th><td>${environment.test.environment}</td></tr>
                <tr><th>Base URL:</th><td>${environment.test.baseUrl}</td></tr>
                <tr><th>API Base URL:</th><td>${environment.test.apiBaseUrl}</td></tr>
                <tr><th>Browser:</th><td>${environment.test.browser}</td></tr>
                <tr><th>Browser Version:</th><td>${environment.test.browserVersion}</td></tr>
                <tr><th>Headless Mode:</th><td>${environment.test.headless}</td></tr>
                <tr><th>Screenshot Mode:</th><td>${environment.test.screenshotMode}</td></tr>
                <tr><th>Video Recording:</th><td>${environment.test.videoRecording}</td></tr>
            </table>
        </div>

        <div class="env-section">
            <div class="env-section-title">
                ⚙️ Execution Settings
            </div>
            <table class="env-table">
                <tr><th>Parallel Execution:</th><td>${environment.execution.parallel}</td></tr>
                <tr><th>Max Workers:</th><td>${environment.execution.maxWorkers}</td></tr>
                <tr><th>Test Timeout:</th><td>${environment.execution.timeout}</td></tr>
                <tr><th>Network Recording:</th><td>${environment.execution.networkRecording}</td></tr>
            </table>
        </div>

        <div class="env-section">
            <div class="env-section-title">
                🔧 Runtime Information
            </div>
            <table class="env-table">
                <tr><th>Node Version:</th><td>${environment.runtime.nodeVersion}</td></tr>
                <tr><th>Playwright Version:</th><td>${environment.runtime.playwrightVersion}</td></tr>
                <tr><th>Hostname:</th><td>${environment.system.hostname}</td></tr>
                <tr><th>User:</th><td>${environment.system.user}</td></tr>
                <tr><th>Home Directory:</th><td>${environment.system.homeDir}</td></tr>
                <tr><th>Report Generated:</th><td>${environment.runtime.reportGenerated}</td></tr>
                <tr><th>Time Zone:</th><td>${environment.runtime.timezone}</td></tr>
            </table>
        </div>`;
    }

    /**
     * Generate enhanced artifacts view with better alignment
     */
    private static generateEnhancedArtifactsView(artifacts: Artifacts): string {
        const generateArtifactCard = (title: string, icon: string, artifactList: Artifact[], color: string) => `
            <div class="card">
                <div class="card-header" style="background: ${color}; color: white;">
                    <div class="card-title">${icon} ${title} (${(artifactList || []).length})</div>
                </div>
                <div class="card-content">
                    <div class="artifact-list">
                        ${artifactList && artifactList.length > 0 ?
                            artifactList.map(artifact => `
                                <div class="artifact-item">
                                    <a href="${artifact.path}" target="_blank" class="artifact-name">
                                        ${artifact.name}
                                    </a>
                                    <span class="artifact-size">(${this.formatFileSize(artifact.size)})</span>
                                </div>
                            `).join('') :
                            '<div class="text-muted text-center">No artifacts available</div>'
                        }
                    </div>
                </div>
            </div>
        `;

        return `
        <h2>Test Artifacts</h2>

        <div class="artifacts-grid">
            ${generateArtifactCard('Screenshots', '📷', artifacts?.screenshots || [], '#10b981')}
            ${generateArtifactCard('Videos', '🎥', artifacts?.videos || [], '#3b82f6')}
            ${generateArtifactCard('HAR Files', '🌐', artifacts?.har || [], '#f59e0b')}
            ${generateArtifactCard('Traces', '🔍', artifacts?.traces || [], '#ef4444')}
            ${generateArtifactCard('Console Logs', '📝', artifacts?.consoleLogs || [], '#6b7280')}
        </div>`;
    }

    /**
     * Generate footer
     */
    private static generateFooter(): string {
        return `
        <footer class="footer">
            <div class="footer-content">
                <p>
                    Generated by <strong>CS Playwright Test Automation Framework v1.0</strong> |
                    ${new Date().toLocaleString()} |
                    <a href="#" onclick="window.print()" style="color: var(--brand-color); text-decoration: none;">🖨️ Print Report</a> |
                    <a href="report-data.json" download style="color: var(--brand-color); text-decoration: none;">💾 Export JSON</a>
                </p>
            </div>
        </footer>`;
    }

    /**
     * Generate enhanced JavaScript with all functionality
     */
    private static generateEnhancedJavaScript(suite: TestSuite, stats: any, artifacts: Artifacts, history: ExecutionHistory[]): string {
        // Generate timeline data here for use in JavaScript
        const scenarios = suite.scenarios || [];
        const startTime = suite.startTime ? new Date(suite.startTime).getTime() : Date.now();

        // Group scenarios by actual worker ID (same logic as generateTimelineView)
        const workerMap = new Map<number, any[]>();

        scenarios.forEach((scenario: any, index) => {
            const scenarioStart = scenario.startTime ? new Date(scenario.startTime).getTime() : startTime + (index * 1000);
            const scenarioEnd = scenario.endTime ? new Date(scenario.endTime).getTime() : scenarioStart + (scenario.duration || 1000);

            // Use actual workerId if available, otherwise default to 1
            const workerId = scenario.workerId || 1;

            if (!workerMap.has(workerId)) {
                workerMap.set(workerId, []);
            }

            workerMap.get(workerId)!.push({
                name: scenario.name,
                feature: scenario.feature || 'Unknown',
                status: scenario.status,
                startTime: scenarioStart,
                endTime: scenarioEnd,
                duration: scenario.duration || (scenarioEnd - scenarioStart),
                workerId: workerId
            });
        });

        // Convert map to array for display (sorted by worker ID)
        const workerEntries = Array.from(workerMap.entries())
            .sort((a, b) => a[0] - b[0]);
        const threads = workerEntries.map(entry => entry[1]);
        const workerIds = workerEntries.map(entry => entry[0]);
        return `
        // Initialize dayjs plugins
        dayjs.extend(dayjs_plugin_duration);
        dayjs.extend(dayjs_plugin_relativeTime);
        
        // Custom charts are ready to use

        // Global variables
        let charts = {};

        // Navigation functionality
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', function() {
                const viewName = this.dataset.view;

                // Update active nav
                document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
                this.classList.add('active');

                // Update active view
                document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                const targetView = document.getElementById(viewName + '-view');
                if (targetView) {
                    targetView.classList.add('active');
                } else {
                    console.error('View not found:', viewName + '-view');
                }

                // Initialize charts for the active view
                setTimeout(() => initializeChartsForView(viewName), 100);
            });
        });

        // Initialize charts based on active view
        function initializeChartsForView(viewName) {
            // Clear existing charts when switching views
            Object.keys(charts).forEach(key => {
                if (charts[key] && charts[key].destroy) {
                    charts[key].destroy();
                }
            });
            charts = {};

            if (viewName === 'dashboard') {
                initializeDashboardCharts();
            } else if (viewName === 'timeline') {
                // Initialize timeline Gantt chart
                const timelineData = ${JSON.stringify(threads)};
                const workerIds = ${JSON.stringify(workerIds)};
                setTimeout(() => {
                    initializeTimelineGantt(timelineData, workerIds);
                }, 200);
            } else if (viewName === 'failure-analysis') {
                initializeFailureAnalysisCharts();
            } else if (viewName === 'categories') {
                initializeCategoryCharts();
            }
        }

        // Dashboard charts initialization
        function initializeTimelineGantt(timelineData, workerIds) {
            const canvas = document.getElementById('timeline-gantt-chart');
            if (!canvas || !timelineData || timelineData.length === 0) {
                console.log('Timeline chart initialization failed:', {
                    canvas: !!canvas,
                    data: !!timelineData,
                    dataLength: timelineData ? timelineData.length : 0
                });
                return;
            }

            const ctx = canvas.getContext('2d');

            // Ensure canvas has valid dimensions
            const rect = canvas.getBoundingClientRect();
            let canvasWidth = rect.width || canvas.offsetWidth || 1200;
            let canvasHeight = rect.height || canvas.offsetHeight || 400;

            // Fallback to default dimensions if still invalid
            if (canvasWidth <= 0) canvasWidth = 1200;
            if (canvasHeight <= 0) canvasHeight = 400;

            // Set canvas dimensions without devicePixelRatio scaling to avoid issues
            canvas.width = canvasWidth;
            canvas.height = canvasHeight;
            canvas.style.width = canvasWidth + 'px';
            canvas.style.height = canvasHeight + 'px';

            console.log('Canvas dimensions set:', { width: canvasWidth, height: canvasHeight });
            const colors = {
                'passed': '#10b981',
                'failed': '#ef4444',
                'skipped': '#f59e0b'
            };
            
            // Find min and max times
            let minTime = Infinity;
            let maxTime = -Infinity;
            
            timelineData.forEach(thread => {
                thread.forEach(scenario => {
                    minTime = Math.min(minTime, scenario.startTime);
                    maxTime = Math.max(maxTime, scenario.endTime);
                });
            });
            
            const totalDuration = maxTime - minTime;
            const chartWidth = canvasWidth;
            const chartHeight = canvasHeight;
            const barHeight = 30; // Reduced from 40
            const barGap = 8;     // Reduced from 10
            const leftMargin = 80;  // Reduced from 100
            const rightMargin = 30; // Reduced from 50
            const topMargin = 30;   // Added top margin

            // Debug log
            console.log('Timeline data:', {
                threads: timelineData.length,
                totalScenarios: timelineData.reduce((acc, thread) => acc + thread.length, 0),
                minTime: new Date(minTime).toISOString(),
                maxTime: new Date(maxTime).toISOString(),
                totalDuration: totalDuration
            });
            
            // Clear canvas and add background
            ctx.clearRect(0, 0, chartWidth, chartHeight);

            // Draw white background
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, chartWidth, chartHeight);

            // Draw border
            ctx.strokeStyle = '#e5e7eb';
            ctx.lineWidth = 1;
            ctx.strokeRect(0, 0, chartWidth, chartHeight);

            // Draw chart title
            ctx.fillStyle = '#1f2937';
            ctx.font = 'bold 14px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('Test Execution Timeline', chartWidth / 2, 15);

            // Check if we have valid time range
            if (!isFinite(minTime) || !isFinite(maxTime) || totalDuration <= 0) {
                ctx.fillStyle = '#6b7280';
                ctx.font = '14px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('No timeline data available', chartWidth / 2, chartHeight / 2);
                return;
            }

            // Draw thread labels and scenarios
            timelineData.forEach((thread, threadIndex) => {
                const y = topMargin + threadIndex * (barHeight + barGap);

                // Draw thread label with better font
                ctx.fillStyle = '#333';
                ctx.font = '11px Arial';
                ctx.textAlign = 'right';
                // Use actual worker ID from workerIds array
                const workerId = workerIds && workerIds[threadIndex] ? workerIds[threadIndex] : (threadIndex + 1);
                ctx.fillText('Worker ' + workerId, leftMargin - 10, y + barHeight / 2 + 5);
                
                // Draw scenarios in thread
                thread.forEach(scenario => {
                    const x = leftMargin + ((scenario.startTime - minTime) / totalDuration) * (chartWidth - leftMargin - rightMargin);
                    const width = (scenario.duration / totalDuration) * (chartWidth - leftMargin - rightMargin);
                    
                    // Draw scenario bar
                    ctx.fillStyle = colors[scenario.status] || '#999';
                    ctx.fillRect(x, y, width, barHeight);

                    // Add border to make bars more visible
                    ctx.strokeStyle = '#fff';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(x, y, width, barHeight);

                    // Draw scenario name horizontally inside the bar
                    if (width > 30) {
                        ctx.save();
                        ctx.fillStyle = '#fff';
                        ctx.font = 'bold 11px Arial';
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';

                        // Calculate max text width
                        const maxTextWidth = width - 10;
                        let text = scenario.name;

                        // Truncate text if needed
                        const metrics = ctx.measureText(text);
                        if (metrics.width > maxTextWidth) {
                            while (ctx.measureText(text + '...').width > maxTextWidth && text.length > 0) {
                                text = text.substring(0, text.length - 1);
                            }
                            text = text + '...';
                        }

                        // Draw text with shadow for better visibility
                        ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
                        ctx.shadowBlur = 2;
                        ctx.fillText(text, x + 5, y + barHeight / 2);
                        ctx.restore();
                    }
                });
            });
            
            // Draw time axis
            ctx.strokeStyle = '#ddd';
            ctx.beginPath();
            ctx.moveTo(leftMargin, chartHeight - 30);
            ctx.lineTo(chartWidth - rightMargin, chartHeight - 30);
            ctx.stroke();
            
            // Draw time labels
            const timePoints = 5;
            for (let i = 0; i <= timePoints; i++) {
                const x = leftMargin + (i / timePoints) * (chartWidth - leftMargin - rightMargin);
                const time = minTime + (i / timePoints) * totalDuration;
                
                ctx.strokeStyle = '#ddd';
                ctx.beginPath();
                ctx.moveTo(x, chartHeight - 35);
                ctx.lineTo(x, chartHeight - 25);
                ctx.stroke();
                
                ctx.fillStyle = '#666';
                ctx.font = '10px Arial';
                ctx.textAlign = 'center';
                ctx.fillText(new Date(time).toLocaleTimeString(), x, chartHeight - 10);
            }
        }

        function initializeDashboardCharts() {
            // Test Duration Distribution Chart
            const statusCtx = document.getElementById('status-chart');
            if (statusCtx && !charts.status) {
                // Categorize tests by duration
                const scenarios = ${JSON.stringify(suite.scenarios.map(s => ({
                    duration: s.duration || 0,
                    name: s.name
                })))};

                // Define duration categories (in milliseconds)
                const categories = {
                    'Fast (<5s)': 0,
                    'Medium (5-15s)': 0,
                    'Slow (15-30s)': 0,
                    'Very Slow (>30s)': 0
                };

                // Categorize each test
                scenarios.forEach(scenario => {
                    const duration = scenario.duration;
                    if (duration < 5000) {
                        categories['Fast (<5s)']++;
                    } else if (duration < 15000) {
                        categories['Medium (5-15s)']++;
                    } else if (duration < 30000) {
                        categories['Slow (15-30s)']++;
                    } else {
                        categories['Very Slow (>30s)']++;
                    }
                });

                charts.status = new CSChart(statusCtx, {
                    type: 'bar',
                    data: {
                        labels: Object.keys(categories),
                        datasets: [{
                            label: 'Number of Tests',
                            data: Object.values(categories),
                            backgroundColor: [
                                '#10b981', // Fast - green
                                '#3b82f6', // Medium - blue
                                '#f59e0b', // Slow - yellow
                                '#ef4444'  // Very Slow - red
                            ],
                            borderWidth: 1,
                            borderColor: '#e5e7eb'
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            y: {
                                beginAtZero: true,
                                ticks: {
                                    stepSize: 1,
                                    precision: 0
                                },
                                title: {
                                    display: true,
                                    text: 'Number of Tests'
                                }
                            },
                            x: {
                                title: {
                                    display: true,
                                    text: 'Duration Category'
                                }
                            }
                        },
                        plugins: {
                            legend: {
                                display: false
                            },
                            tooltip: {
                                callbacks: {
                                    label: function(context) {
                                        const total = scenarios.length;
                                        // Robust value extraction for different chart contexts
                                        let value = context.parsed?.y ?? context.raw ?? context.formattedValue;

                                        // Fallback: Get from dataset directly
                                        if (value === undefined || value === null) {
                                            value = context.dataset.data[context.dataIndex];
                                        }

                                        // Final fallback to 0
                                        value = value ?? 0;

                                        const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0';
                                        return 'Tests: ' + value + ' (' + percentage + '%)';
                                    }
                                }
                            },
                            datalabels: {
                                anchor: 'end',
                                align: 'end',
                                color: '#374151',
                                font: {
                                    weight: 'bold',
                                    size: 12
                                },
                                formatter: function(value) {
                                    return value > 0 ? value : '';
                                }
                            }
                        }
                    }
                });
            }

            // Test Execution Summary Chart (replacing heatmap)
            const summaryCtx = document.getElementById('heatmap-chart');
            if (summaryCtx && !charts.summary) {
                // Group scenarios for comprehensive summary
                const scenarios = ${JSON.stringify(suite.scenarios.map(s => ({
                    name: s.name,
                    duration: s.duration || 0,
                    status: s.status,
                    startTime: s.startTime
                })))};

                // Create pass/fail distribution with timing
                const passedTests = scenarios.filter(s => s.status === 'passed');
                const failedTests = scenarios.filter(s => s.status === 'failed');
                const skippedTests = scenarios.filter(s => s.status === 'skipped');

                // Create a clearer summary with just test counts and pass rate
                const totalTests = scenarios.length;
                const passRate = totalTests > 0 ? Math.round((passedTests.length / totalTests) * 100) : 0;

                charts.summary = new CSChart(summaryCtx, {
                    type: 'doughnut',
                    data: {
                        labels: ['Passed', 'Failed', 'Skipped'],
                        datasets: [{
                            data: [passedTests.length, failedTests.length, skippedTests.length],
                            backgroundColor: ['#10b981', '#ef4444', '#f59e0b'],
                            borderWidth: 2,
                            borderColor: '#fff'
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: {
                                position: 'right',
                                labels: {
                                    generateLabels: function(chart) {
                                        const data = chart.data;
                                        const datasets = chart.data.datasets;
                                        const labels = data.labels;

                                        return labels.map((label, i) => {
                                            const value = datasets[0].data[i];
                                            const percentage = totalTests > 0 ? Math.round((value / totalTests) * 100) : 0;
                                            return {
                                                text: label + ': ' + value + ' (' + percentage + '%)',
                                                fillStyle: datasets[0].backgroundColor[i],
                                                hidden: false,
                                                index: i
                                            };
                                        });
                                    }
                                }
                            },
                            datalabels: {
                                display: true,
                                color: '#fff',
                                font: {
                                    size: 16,
                                    weight: 'bold'
                                },
                                formatter: function(value, context) {
                                    const percentage = totalTests > 0 ? Math.round((value / totalTests) * 100) : 0;
                                    return value > 0 ? value + '\\n(' + percentage + '%)' : '';
                                }
                            },
                            title: {
                                display: true,
                                text: 'Pass Rate: ' + passRate + '%',
                                font: {
                                    size: 14,
                                    weight: 'bold'
                                },
                                color: passRate >= 80 ? '#10b981' : passRate >= 50 ? '#f59e0b' : '#ef4444'
                            }
                        }
                    }
                });
            }

            // Feature Performance Chart
            const featureCtx = document.getElementById('feature-chart');
            if (featureCtx && !charts.feature) {
                const featureData = ${JSON.stringify((stats.featureStats || []).slice(0, 10))};
                charts.feature = new CSChart(featureCtx, {
                    type: 'bar',
                    data: {
                        labels: featureData.map(f => f.name.substring(0, 20) + '...'),
                        datasets: [
                            {
                                label: 'Passed',
                                data: featureData.map(f => f.passed),
                                backgroundColor: '#10b981'
                            },
                            {
                                label: 'Failed',
                                data: featureData.map(f => f.failed),
                                backgroundColor: '#ef4444'
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            x: {
                                stacked: true
                            },
                            y: {
                                stacked: true
                            }
                        },
                        plugins: {
                            legend: {
                                position: 'right'
                            }
                        }
                    }
                });
            }

            // Execution Trend Chart (Last 7 Days)
            const trendCtx = document.getElementById('trend-chart');
            console.log('[Trend Chart] Canvas element:', trendCtx);
            console.log('[Trend Chart] CSChart available:', typeof CSChart);
            console.log('[Trend Chart] History data:', ${JSON.stringify(history)});

            if (trendCtx && !charts.trend) {
                // Use the LATEST history entry's date as reference to avoid timezone issues
                const historyData = ${JSON.stringify(history)};
                const latestEntry = historyData[historyData.length - 1];

                // If no history, use current date, otherwise use latest entry's date
                const referenceDate = latestEntry ? latestEntry.date : new Date().toISOString().split('T')[0];

                const last7Days = [];
                const trendValues = [];

                for (let i = 6; i >= 0; i--) {
                    // Parse reference date and subtract days
                    const [year, month, day] = referenceDate.split('-').map(Number);
                    const targetDate = new Date(year, month - 1, day - i);

                    // TIMEZONE FIX: Don't use toISOString() as it converts to UTC and can shift dates
                    // Build date string directly from the Date components in local timezone
                    const dateStr = \`\${targetDate.getFullYear()}-\${String(targetDate.getMonth() + 1).padStart(2, '0')}-\${String(targetDate.getDate()).padStart(2, '0')}\`;
                    last7Days.push(targetDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));

                    // MULTIPLE EXECUTIONS FIX: Find ALL matching history entries for this date
                    // (there can be multiple executions per day)
                    const dayEntries = historyData.filter(h => h.date === dateStr);

                    // Use the LAST execution of the day (most recent timestamp)
                    const historyEntry = dayEntries.length > 0 ? dayEntries[dayEntries.length - 1] : null;
                    const passRate = historyEntry ? historyEntry.passRate : 0;
                    trendValues.push(passRate);

                    // Debug: log what we're searching for
                    console.log(\`[Trend] Day \${i}: dateStr=\${dateStr}, found=\${dayEntries.length} executions, passRate=\${passRate}\`);
                }

                console.log('[Trend Chart] Labels:', last7Days);
                console.log('[Trend Chart] Values:', trendValues);
                console.log('[Trend Chart] Max value:', Math.max(...trendValues));
                console.log('[Trend Chart] Non-zero values:', trendValues.filter(v => v > 0).length);

                try {
                    charts.trend = new CSChart(trendCtx, {
                        type: 'line',
                        data: {
                            labels: last7Days,
                            datasets: [{
                                data: trendValues,
                                borderColor: '#93186C',
                                backgroundColor: 'rgba(147, 24, 108, 0.1)',
                                tension: 0.4,
                                fill: true,
                                borderWidth: 2
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: {
                                legend: { display: false },
                                datalabels: { display: true }
                            }
                        }
                    });
                    console.log('[Trend Chart] Chart created successfully');
                } catch (error) {
                    console.error('[Trend Chart] Error creating chart:', error);
                }

                // Remove duplicate chart creation - already created above
            } else {
                console.log('[Trend Chart] Skipped - element not found or chart already exists');
            }

            // Tag Distribution Chart - Only for dashboard view
            const tagCtx = document.getElementById('tag-chart');
            if (tagCtx && !charts.tag && document.getElementById('dashboard-view').classList.contains('active')) {
                const tagData = ${JSON.stringify((stats.tagStats || []).slice(0, 10))};
                charts.tag = new CSChart(tagCtx, {
                    type: 'bar',
                    data: {
                        labels: tagData.map(t => t.tag),
                        datasets: [{
                            label: 'Usage Count',
                            data: tagData.map(t => t.count),
                            backgroundColor: '${this.brandColor}',
                            borderRadius: 4
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: {
                                display: false
                            }
                        },
                        scales: {
                            y: {
                                beginAtZero: true
                            }
                        }
                    }
                });
            }
        }

        // Failure Analysis charts
        function initializeFailureAnalysisCharts() {
            const failureCategoriesCtx = document.getElementById('failure-categories-chart');
            if (failureCategoriesCtx && !charts.failureCategories) {
                const failureData = ${JSON.stringify(stats.failureReasons || [])};
                if (failureData && failureData.length > 0) {
                    charts.failureCategories = new CSChart(failureCategoriesCtx, {
                    type: 'pie',
                    data: {
                        labels: failureData.map(f => f.reason),
                        datasets: [{
                            data: failureData.map(f => f.count),
                            backgroundColor: [
                                '#ef4444', '#f59e0b', '#10b981', '#3b82f6', 
                                '#8b5cf6', '#f97316', '#06b6d4', '#84cc16'
                            ]
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: {
                                position: 'right',
                                labels: {
                                    padding: 20,
                                    usePointStyle: true
                                }
                            }
                        }
                    }
                });
                }
            }
        }

        // Category charts
        function initializeCategoryCharts() {
            const featureDistCtx = document.getElementById('feature-distribution-chart');
            if (featureDistCtx && !charts.featureDistribution) {
                const featureData = ${JSON.stringify((stats.featureStats || []).slice(0, 8))};
                charts.featureDistribution = new CSChart(featureDistCtx, {
                    type: 'doughnut',
                    data: {
                        labels: featureData.map(f => f.name),
                        datasets: [{
                            data: featureData.map(f => f.total),
                            backgroundColor: [
                                '#ef4444', '#f59e0b', '#10b981', '#3b82f6',
                                '#8b5cf6', '#f97316', '#06b6d4', '#84cc16'
                            ]
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: {
                                position: 'right',
                                labels: {
                                    padding: 20,
                                    usePointStyle: true
                                }
                            }
                        }
                    }
                });
            }
        }

        // Hierarchical view toggle functions
        function toggleFeature(element) {
            const scenarios = element.nextElementSibling;
            const icon = element.querySelector('.toggle-icon');
            
            if (scenarios.classList.contains('expanded')) {
                scenarios.classList.remove('expanded');
                icon.textContent = '▶';
                icon.classList.remove('expanded');
            } else {
                scenarios.classList.add('expanded');
                icon.textContent = '▼';
                icon.classList.add('expanded');
            }
        }

        function toggleScenario(element) {
            const steps = element.nextElementSibling;
            const icon = element.querySelector('.toggle-icon');
            
            if (steps.classList.contains('expanded')) {
                steps.classList.remove('expanded');
                icon.textContent = '▶';
                icon.classList.remove('expanded');
            } else {
                steps.classList.add('expanded');
                icon.textContent = '▼';
                icon.classList.add('expanded');
            }
        }

        function toggleStep(element) {
            const details = element.nextElementSibling;
            const icon = element.querySelector('.toggle-icon');

            if (details.classList.contains('expanded')) {
                details.classList.remove('expanded');
                icon.textContent = '▶';
                icon.classList.remove('expanded');
            } else {
                details.classList.add('expanded');
                icon.textContent = '▼';
                icon.classList.add('expanded');
            }
        }

        function toggleAllColumns(scenarioId) {
            const allColumns = document.getElementById('all-columns-' + scenarioId);
            const usedColumns = document.getElementById('used-columns-' + scenarioId);
            const toggleBtn = document.getElementById('toggle-btn-' + scenarioId);

            if (allColumns && usedColumns && toggleBtn) {
                if (allColumns.style.display === 'none' || !allColumns.style.display) {
                    allColumns.style.display = 'block';
                    usedColumns.style.display = 'none';
                    toggleBtn.textContent = 'Show Used Only';
                } else {
                    allColumns.style.display = 'none';
                    usedColumns.style.display = 'block';
                    toggleBtn.textContent = 'Show All Columns';
                }
            }
        }

        function showStepTab(tabElement, tabId) {
            // Find the parent step-details container
            const stepDetails = tabElement.closest('.step-details');
            if (!stepDetails) return;
            
            // Remove active class from all tabs in this step
            stepDetails.querySelectorAll('.step-tab').forEach(tab => {
                tab.classList.remove('active');
            });
            
            // Add active class to clicked tab
            tabElement.classList.add('active');
            
            // Hide all tab panes in this step
            stepDetails.querySelectorAll('.step-tab-pane').forEach(pane => {
                pane.classList.remove('active');
                pane.style.display = 'none';
            });
            
            // Show the selected tab pane
            const targetPane = stepDetails.querySelector('#' + tabId);
            if (targetPane) {
                targetPane.classList.add('active');
                targetPane.style.display = 'block';
            }
        }

        // Screenshot modal functionality
        function showScreenshotModal(imageSrc) {
            const modal = document.getElementById('screenshot-modal');
            const img = document.getElementById('screenshot-img');
            img.src = imageSrc;
            modal.style.display = 'block';
        }

        // Modal close functionality
        document.querySelectorAll('.modal-close').forEach(closeBtn => {
            closeBtn.addEventListener('click', function() {
                this.closest('.modal').style.display = 'none';
            });
        });

        // Click outside modal to close
        window.addEventListener('click', function(event) {
            if (event.target.classList.contains('modal')) {
                event.target.style.display = 'none';
            }
        });

        // Search functionality
        const searchBox = document.getElementById('test-search');
        if (searchBox) {
            searchBox.addEventListener('input', function() {
                const searchTerm = this.value.toLowerCase();
                
                document.querySelectorAll('.feature-item').forEach(feature => {
                    const featureName = feature.querySelector('.feature-header').textContent.toLowerCase();
                    const scenarios = feature.querySelectorAll('.scenario-item');
                    let hasMatchingScenario = false;
                    
                    scenarios.forEach(scenario => {
                        const scenarioName = scenario.querySelector('.scenario-header').textContent.toLowerCase();
                        if (scenarioName.includes(searchTerm)) {
                            scenario.style.display = 'block';
                            hasMatchingScenario = true;
                        } else {
                            scenario.style.display = 'none';
                        }
                    });
                    
                    if (featureName.includes(searchTerm) || hasMatchingScenario) {
                        feature.style.display = 'block';
                    } else {
                        feature.style.display = 'none';
                    }
                });
            });
        }

        // Render custom test execution heat map
        function renderTestExecutionHeatMap(canvas, scenarios) {
            if (!scenarios || scenarios.length === 0) return;

            const ctx = canvas.getContext('2d');
            const rect = canvas.getBoundingClientRect();
            canvas.width = rect.width || canvas.offsetWidth;
            canvas.height = rect.height || canvas.offsetHeight;

            // Group scenarios by hour and day
            const hourlyData = {};
            let totalPassed = 0;
            let totalFailed = 0;

            scenarios.forEach(scenario => {
                const date = new Date(scenario.startTime || Date.now());
                const hour = date.getHours();
                const day = date.toLocaleDateString('en-US', { weekday: 'short' });

                if (!hourlyData[day]) hourlyData[day] = {};
                if (!hourlyData[day][hour]) hourlyData[day][hour] = { passed: 0, failed: 0, total: 0 };

                hourlyData[day][hour].total++;
                if (scenario.status === 'passed') {
                    hourlyData[day][hour].passed++;
                    totalPassed++;
                } else if (scenario.status === 'failed') {
                    hourlyData[day][hour].failed++;
                    totalFailed++;
                }
            });


            // Setup dimensions
            const margin = { left: 50, top: 30, right: 20, bottom: 40 };
            const cellWidth = Math.max(20, (canvas.width - margin.left - margin.right) / 24);
            const days = Object.keys(hourlyData);
            const cellHeight = Math.max(30, (canvas.height - margin.top - margin.bottom) / Math.max(days.length, 1));

            // Clear canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Draw cells for each hour/day combination
            days.forEach((day, dayIndex) => {
                for (let hour = 0; hour < 24; hour++) {
                    const x = margin.left + hour * cellWidth;
                    const y = margin.top + dayIndex * cellHeight;

                    let color = '#f3f4f6'; // Default gray for no tests
                    let textColor = '#666';
                    let value = '';

                    if (hourlyData[day] && hourlyData[day][hour]) {
                        const stats = hourlyData[day][hour];
                        const passRate = stats.total > 0 ? (stats.passed / stats.total) : 0;

                        // Color based on pass rate
                        if (passRate > 0.8) {
                            color = '#10b981'; // Green
                            textColor = '#fff';
                        } else if (passRate > 0.5) {
                            color = '#f59e0b'; // Orange
                            textColor = '#fff';
                        } else if (stats.total > 0) {
                            color = '#ef4444'; // Red
                            textColor = '#fff';
                        }

                        value = stats.total.toString();
                    }

                    // Draw cell
                    ctx.fillStyle = color;
                    ctx.fillRect(x, y, cellWidth - 2, cellHeight - 2);

                    // Draw value if exists
                    if (value) {
                        ctx.fillStyle = textColor;
                        ctx.font = '11px sans-serif';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(value, x + cellWidth/2, y + cellHeight/2);
                    }
                }

                // Draw day labels
                ctx.fillStyle = '#666';
                ctx.font = '12px sans-serif';
                ctx.textAlign = 'right';
                ctx.textBaseline = 'middle';
                ctx.fillText(day, margin.left - 5, margin.top + dayIndex * cellHeight + cellHeight/2);
            });

            // Draw hour labels
            ctx.fillStyle = '#666';
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'center';
            for (let hour = 0; hour < 24; hour++) {
                if (hour % 3 === 0) { // Show every 3rd hour
                    const x = margin.left + hour * cellWidth + cellWidth/2;
                    ctx.fillText(hour + ':00', x, canvas.height - 20);
                }
            }

            // Don't draw title as it's already in the container

            // Draw legend
            const legendItems = [
                { color: '#10b981', label: '>80% Pass' },
                { color: '#f59e0b', label: '50-80%' },
                { color: '#ef4444', label: '<50% Pass' },
                { color: '#f3f4f6', label: 'No Tests' }
            ];

            ctx.font = '10px sans-serif';
            let legendX = canvas.width - 250;
            const legendY = 10;

            legendItems.forEach(item => {
                ctx.fillStyle = item.color;
                ctx.fillRect(legendX, legendY, 12, 12);
                ctx.fillStyle = '#666';
                ctx.textAlign = 'left';
                ctx.fillText(item.label, legendX + 15, legendY + 9);
                legendX += 60;
            });
        }

        // Initialize dashboard charts by default
        setTimeout(() => {
            initializeChartsForView('dashboard');
        }, 500);
        `;
    }

    private static generateSupportingFiles(suite: TestSuite, artifacts: Artifacts, history: ExecutionHistory[], outputDir: string): void {
        // Generate report-data.json
        const reportData = {
            suite,
            artifacts,
            history,
            generatedAt: new Date().toISOString()
        };
        
        fs.writeFileSync(
            path.join(outputDir, 'report-data.json'),
            JSON.stringify(reportData, null, 2)
        );
    }

    /**
     * Generate Speedboard section - Playwright 1.57 inspired feature
     * Shows all scenarios sorted by duration with visual duration bars and percentile indicators
     */
    private static generateSpeedboard(stats: any): string {
        // Get all scenarios sorted by duration (slowest first)
        const allScenarios = stats.performanceMetrics?.allScenarios || [];
        if (allScenarios.length === 0) {
            return '';
        }

        // Sort by duration descending (slowest first - Speedboard style)
        const sortedScenarios = [...allScenarios].sort((a: any, b: any) => b.duration - a.duration);

        // Calculate max duration for progress bar scaling
        const maxDuration = sortedScenarios.length > 0 ? sortedScenarios[0].duration : 1;

        // Calculate percentiles for color coding
        const durations = sortedScenarios.map((s: any) => s.duration);
        const p75 = this.calculatePercentile(durations, 75);
        const p90 = this.calculatePercentile(durations, 90);

        // Calculate statistics
        const totalDuration = durations.reduce((sum: number, d: number) => sum + d, 0);
        const avgDuration = totalDuration / durations.length;

        // Generate rows for speedboard
        const rows = sortedScenarios.slice(0, 20).map((scenario: any, index: number) => {
            const duration = scenario.duration || 0;
            const progressPercent = maxDuration > 0 ? (duration / maxDuration) * 100 : 0;

            // Determine color class based on percentile
            let colorClass = 'speedboard-fast'; // Green - below p75
            let indicator = '✓';
            if (duration >= p90) {
                colorClass = 'speedboard-slow';
                indicator = '⚠️';
            } else if (duration >= p75) {
                colorClass = 'speedboard-medium';
                indicator = '◐';
            }

            // Determine status icon
            const statusIcon = scenario.status === 'passed' ? '✅' :
                              scenario.status === 'failed' ? '❌' : '⏭️';

            return `
                <tr class="${colorClass}">
                    <td class="speedboard-rank">${index + 1}</td>
                    <td class="speedboard-status">${statusIcon}</td>
                    <td class="speedboard-name" title="${scenario.name}">${scenario.name}</td>
                    <td class="speedboard-duration">
                        <div class="speedboard-bar-container">
                            <div class="speedboard-bar ${colorClass}" style="width: ${progressPercent}%"></div>
                            <span class="speedboard-time">${this.formatDuration(duration)}</span>
                        </div>
                    </td>
                    <td class="speedboard-indicator">${indicator}</td>
                </tr>
            `;
        }).join('');

        return `
        <div class="card speedboard-card">
            <div class="card-header">
                <div class="card-title">⚡ Speedboard - All Tests by Duration</div>
                <div class="card-subtitle">Inspired by Playwright 1.57 • Sorted by execution time (slowest first)</div>
            </div>
            <div class="card-content">
                <div class="speedboard-stats">
                    <div class="speedboard-stat">
                        <span class="stat-label">Total Tests</span>
                        <span class="stat-value">${sortedScenarios.length}</span>
                    </div>
                    <div class="speedboard-stat">
                        <span class="stat-label">Avg Duration</span>
                        <span class="stat-value">${this.formatDuration(avgDuration)}</span>
                    </div>
                    <div class="speedboard-stat">
                        <span class="stat-label">P75 Threshold</span>
                        <span class="stat-value">${this.formatDuration(p75)}</span>
                    </div>
                    <div class="speedboard-stat">
                        <span class="stat-label">P90 Threshold</span>
                        <span class="stat-value">${this.formatDuration(p90)}</span>
                    </div>
                </div>
                <div class="speedboard-legend">
                    <span class="legend-item"><span class="legend-color speedboard-fast"></span> Fast (&lt; P75)</span>
                    <span class="legend-item"><span class="legend-color speedboard-medium"></span> Medium (P75-P90)</span>
                    <span class="legend-item"><span class="legend-color speedboard-slow"></span> Slow (&gt; P90)</span>
                </div>
                <table class="data-table speedboard-table">
                    <thead>
                        <tr>
                            <th class="speedboard-rank-header">#</th>
                            <th class="speedboard-status-header">Status</th>
                            <th class="speedboard-name-header">Scenario</th>
                            <th class="speedboard-duration-header">Duration</th>
                            <th class="speedboard-indicator-header">Perf</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
                ${sortedScenarios.length > 20 ? `<div class="speedboard-more">Showing top 20 slowest of ${sortedScenarios.length} total tests</div>` : ''}
            </div>
        </div>
        `;
    }

    /**
     * Calculate percentile value from array of numbers
     */
    private static calculatePercentile(values: number[], percentile: number): number {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const index = Math.ceil((percentile / 100) * sorted.length) - 1;
        return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
    }

    private static formatDuration(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    private static formatFileSize(bytes: number): string {
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        if (bytes === 0) return '0 Bytes';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
    }
}