/**
 * Report aggregator for parallel test execution
 * Collects and consolidates results from multiple workers
 */

import * as fs from 'fs';
import * as path from 'path';
import { CSReporter } from './CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSHtmlReportGenerator } from './CSHtmlReportGeneration';
import { CSTestResultsManager } from './CSTestResultsManager';
import { CSADOIntegration } from '../ado/CSADOIntegration';
import { CSSecretMasker } from '../utils/CSSecretMasker';

export class CSReportAggregator {
    private static instance: CSReportAggregator;
    private config = CSConfigurationManager.getInstance();
    private aggregatedResults: any = {
        scenarios: [],
        artifacts: {
            screenshots: [],
            videos: [],
            traces: [],
            logs: []
        },
        stats: {
            totalScenarios: 0,
            passed: 0,
            failed: 0,
            skipped: 0,
            totalSteps: 0,
            passedSteps: 0,
            failedSteps: 0,
            skippedSteps: 0
        }
    };

    private constructor() {}

    public static getInstance(): CSReportAggregator {
        if (!CSReportAggregator.instance) {
            CSReportAggregator.instance = new CSReportAggregator();
        }
        return CSReportAggregator.instance;
    }

    /**
     * Aggregate results from parallel execution
     */
    public async aggregateParallelResults(scenarios: any[], artifacts: any) {
        CSReporter.debug('Aggregating parallel execution results');

        // Aggregate scenarios
        this.aggregatedResults.scenarios = scenarios;
        this.aggregatedResults.stats.totalScenarios = scenarios.length;

        // Calculate stats
        scenarios.forEach(scenario => {
            if (scenario.status === 'passed') {
                this.aggregatedResults.stats.passed++;
            } else if (scenario.status === 'failed') {
                this.aggregatedResults.stats.failed++;
            } else {
                this.aggregatedResults.stats.skipped++;
            }

            // Count steps
            if (scenario.steps && Array.isArray(scenario.steps)) {
                scenario.steps.forEach((step: any) => {
                    this.aggregatedResults.stats.totalSteps++;
                    if (step.status === 'passed') {
                        this.aggregatedResults.stats.passedSteps++;
                    } else if (step.status === 'failed') {
                        this.aggregatedResults.stats.failedSteps++;
                    } else {
                        this.aggregatedResults.stats.skippedSteps++;
                    }
                });
            }
        });

        // Aggregate artifacts
        if (artifacts) {
            if (artifacts.screenshots) {
                this.aggregatedResults.artifacts.screenshots.push(...artifacts.screenshots);
            }
            if (artifacts.videos) {
                this.aggregatedResults.artifacts.videos.push(...artifacts.videos);
            }
            if (artifacts.traces) {
                this.aggregatedResults.artifacts.traces.push(...artifacts.traces);
            }
            if (artifacts.logs) {
                this.aggregatedResults.artifacts.logs.push(...artifacts.logs);
            }
        }

        // Generate consolidated report
        await this.generateConsolidatedReport();
    }

    /**
     * Generate consolidated report from aggregated results
     */
    private async generateConsolidatedReport() {
        try {
            // Use the actual test results directory that was created at the start
            let testResultsDir = this.config.get('TEST_RESULTS_DIR');

            // Fallback if TEST_RESULTS_DIR is not set
            if (!testResultsDir) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
                testResultsDir = path.join(process.cwd(), 'reports', `test-results-${timestamp}`);
                CSReporter.warn(`TEST_RESULTS_DIR not set, using fallback: ${testResultsDir}`);
            }

            // Ensure directory exists
            if (!fs.existsSync(testResultsDir)) {
                fs.mkdirSync(testResultsDir, { recursive: true });
            }

            // Calculate total duration
            const totalDuration = this.aggregatedResults.scenarios.reduce((total: number, scenario: any) => {
                return total + (scenario.duration || 0);
            }, 0);

            // Create world-class suite format for professional report
            // Use project name from config, fallback to generic name
            const projectName = this.config.get('PROJECT', 'Unknown');
            const suiteName = projectName !== 'Unknown' ? `${projectName} Test Suite` : 'CS Test Automation Suite';
            const worldClassSuite = {
                name: suiteName,
                scenarios: this.aggregatedResults.scenarios.map((scenario: any) => ({
                    name: scenario.name || 'Unknown',
                    status: scenario.status === 'broken' ? 'failed' : (scenario.status as 'passed' | 'failed' | 'skipped'),
                    feature: scenario.feature || 'Unknown',
                    tags: scenario.tags || [],
                    steps: (scenario.steps || []).map((step: any) => ({
                        name: step.name,
                        status: step.status === 'pending' ? 'skipped' : (step.status as 'passed' | 'failed' | 'skipped'),
                        duration: step.duration || 0,
                        error: step.error?.message || step.error,
                        // Convert log objects to strings like sequential execution does
                        logs: (step.logs || []).map((log: any) =>
                            typeof log === 'string' ? log : `[${log.level || 'INFO'}] ${log.message || log}`
                        ),
                        actions: step.actions || [],
                        screenshot: step.screenshot
                    })),
                    duration: scenario.duration || 0,
                    startTime: scenario.startTime || new Date(),
                    endTime: scenario.endTime || new Date(),
                    workerId: scenario.workerId || 1,  // Add worker ID for timeline
                    testData: this.maskTestData(scenario.testData)  // Add test data with secrets masked
                })),
                startTime: new Date(Date.now() - totalDuration),
                endTime: new Date(),
                duration: totalDuration,
                totalScenarios: this.aggregatedResults.stats.totalScenarios,
                passedScenarios: this.aggregatedResults.stats.passed,
                failedScenarios: this.aggregatedResults.stats.failed
            };

            // Create test data for JSON report with masked secrets
            const testData = {
                project: this.config.get('PROJECT', 'Unknown'),
                environment: this.config.get('ENVIRONMENT', 'Unknown'),
                executionTime: new Date().toISOString(),
                duration: totalDuration,
                stats: this.aggregatedResults.stats,
                scenarios: this.aggregatedResults.scenarios.map((s: any) => ({
                    ...s,
                    testData: this.maskTestData(s.testData)
                })),
                artifacts: this.aggregatedResults.artifacts,
                parallel: true,
                workers: parseInt(this.config.get('PARALLEL_WORKERS', '3'))
            };

            // Ensure reports directory exists inside the test results directory
            const reportsDir = path.join(testResultsDir, 'reports');
            if (!fs.existsSync(reportsDir)) {
                fs.mkdirSync(reportsDir, { recursive: true });
            }

            // Save aggregated results as the MAIN report data (not parallel-specific)
            const jsonPath = path.join(reportsDir, 'report-data.json');
            fs.writeFileSync(jsonPath, JSON.stringify(testData, null, 2));
            CSReporter.info(`Test results saved to: ${jsonPath}`);

            // Generate the MAIN professional HTML report using CSHtmlReportGenerator
            // Pass the reports DIRECTORY, not the file path - the method will create index.html inside it
            await CSHtmlReportGenerator.generateReport(worldClassSuite, reportsDir);
            // CSHtmlReportGenerator already logs the message

            // Generate other report types if needed
            const reportTypes = this.config.get('REPORT_TYPES', 'html').split(',');
            if (reportTypes.includes('junit')) {
                // TODO: Add JUnit report generation
                CSReporter.debug('JUnit report generation not yet implemented for parallel execution');
            }

            CSReporter.info(`✅ Parallel execution report generated successfully`);

            // Finalize test run (ZIP if configured) - conditional based on ADO integration status
            const resultsManager = CSTestResultsManager.getInstance();
            const adoEnabled = this.config.getBoolean('ADO_ENABLED', false);
            const adoIntegration = CSADOIntegration.getInstance();
            const adoPublisher = adoIntegration.getPublisher();

            // Check if ADO is actually active (not just enabled in config, but has test results to publish)
            const adoActiveWithResults = adoEnabled && adoPublisher && adoPublisher.hasTestResults();

            // Determine if we should zip based on:
            // 1. REPORTS_ZIP_RESULTS is explicitly true, OR
            // 2. ADO is active with test results (always zip for ADO)
            const shouldZip = this.config.getBoolean('REPORTS_ZIP_RESULTS', false) || adoActiveWithResults;

            if (shouldZip) {
                if (adoActiveWithResults) {
                    CSReporter.info('Creating zip file for ADO integration with test results');
                } else {
                    CSReporter.info('Creating zip file (ADO not enabled)');
                }
                await resultsManager.finalizeTestRun();
            } else {
                CSReporter.info(`Test results available at: ${resultsManager.getCurrentTestRunDir()}`);
            }

        } catch (error: any) {
            CSReporter.error(`Failed to generate consolidated report: ${error.message}`);
        }
    }

    /**
     * Clear aggregated results (for new test run)
     */
    public clearResults() {
        this.aggregatedResults = {
            scenarios: [],
            artifacts: {
                screenshots: [],
                videos: [],
                traces: [],
                logs: []
            },
            stats: {
                totalScenarios: 0,
                passed: 0,
                failed: 0,
                skipped: 0,
                totalSteps: 0,
                passedSteps: 0,
                failedSteps: 0,
                skippedSteps: 0
            }
        };
    }

    /**
     * Get current aggregated results
     */
    public getResults() {
        return this.aggregatedResults;
    }

    /**
     * Mask sensitive values in test data for reports
     * Applies secret masking to values based on field names and registered secrets
     */
    private maskTestData(testData: any): any {
        if (!testData) return testData;

        const secretMasker = CSSecretMasker.getInstance();

        // Create a deep copy and mask the values
        const masked = { ...testData };

        // Mask the values array based on headers
        if (masked.headers && masked.values && Array.isArray(masked.values)) {
            masked.values = masked.values.map((value: string, idx: number) => {
                const header = masked.headers[idx] || '';
                return secretMasker.maskIfSecret(value, header);
            });
        }

        return masked;
    }
}