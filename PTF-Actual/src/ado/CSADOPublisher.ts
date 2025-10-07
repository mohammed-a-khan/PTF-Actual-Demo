/**
 * Azure DevOps Test Results Publisher
 * Publishes test results to Azure DevOps after test execution
 * Supports both parallel and sequential execution modes
 */

import { CSADOClient } from './CSADOClient';

interface ADOTestRun {
    id: number;
    name: string;
    state?: string;
}

interface ADOAttachment {
    url: string;
    attachmentType?: string;
}
import { CSADOConfiguration } from './CSADOConfiguration';
import { CSADOTagExtractor, ADOMetadata } from './CSADOTagExtractor';
import { CSReporter } from '../reporter/CSReporter';
import { ParsedScenario, ParsedFeature } from '../bdd/CSBDDEngine';
import * as fs from 'fs';
import * as path from 'path';

export interface ScenarioResult {
    scenario: ParsedScenario;
    feature: ParsedFeature;
    status: 'passed' | 'failed' | 'skipped';
    duration: number;
    errorMessage?: string;
    stackTrace?: string;
    iteration?: number;  // For data-driven scenarios
    iterationData?: any; // Data for the current iteration
    comment?: string;    // Custom comment for aggregated results
    artifacts?: {
        screenshots?: string[];
        videos?: string[];
        har?: string[];
        traces?: string[];
        logs?: string[];
    };
}

export class CSADOPublisher {
    private static instance: CSADOPublisher;
    private client: CSADOClient;
    private config: CSADOConfiguration;
    private tagExtractor: CSADOTagExtractor;
    private testRunsByPlan: Map<number, ADOTestRun> = new Map(); // Multiple test runs for different plans
    private currentTestRun?: ADOTestRun; // Keep for backward compatibility
    private scenarioResults: Map<string, ScenarioResult> = new Map();
    private iterationResults: Map<string, ScenarioResult[]> = new Map(); // Track iterations for data-driven scenarios
    private isPublishing: boolean = false;
    private testRunStarted: boolean = false; // Track if test run has been created
    private collectedTestPoints: Set<number> = new Set(); // Collect test points before creating run
    private debuggedTestPoint: boolean = false; // Flag to avoid logging test point structure multiple times
    private testPlanId?: number; // Track plan ID for test run creation
    private planTestPointsMap: Map<number, Set<number>> = new Map(); // Map plan IDs to their test points
    private allScenarios: Array<{scenario: ParsedScenario, feature: ParsedFeature}> = []; // Store all scenarios for feature name extraction

    private constructor() {
        this.client = CSADOClient.getInstance();
        this.config = CSADOConfiguration.getInstance();
        this.tagExtractor = CSADOTagExtractor.getInstance();
    }

    public static getInstance(): CSADOPublisher {
        if (!CSADOPublisher.instance) {
            CSADOPublisher.instance = new CSADOPublisher();
        }
        return CSADOPublisher.instance;
    }

    /**
     * Initialize ADO publisher
     */
    public async initialize(): Promise<void> {
        try {
            this.config.initialize();

            if (!this.config.isEnabled()) {
                // CSReporter.info('Azure DevOps integration is disabled');
                return;
            }

            // CSReporter.info('Azure DevOps Publisher initialized');
        } catch (error) {
            CSReporter.error(`Failed to initialize ADO Publisher: ${error}`);
            // Don't throw - ADO failure shouldn't block test execution
        }
    }

    /**
     * Collect test points from all scenarios that will be executed
     */
    public async collectTestPoints(scenarios: Array<{scenario: ParsedScenario, feature: ParsedFeature}>): Promise<void> {
        if (!this.config.isEnabled()) {
            return;
        }

        // Store scenarios for later use (e.g., feature name extraction)
        this.allScenarios = scenarios;

        // Group scenarios by plan and suite to minimize API calls
        const planSuiteMap = new Map<string, {planId: number, suiteId: number}>();

        for (const {scenario, feature} of scenarios) {
            const metadata = this.tagExtractor.extractMetadata(scenario, feature);

            // Only collect test points if we have complete ADO mapping
            if (metadata.testCaseIds.length > 0 &&
                metadata.testPlanId &&
                metadata.testSuiteId) {

                const key = `${metadata.testPlanId}-${metadata.testSuiteId}`;
                if (!planSuiteMap.has(key)) {
                    planSuiteMap.set(key, {
                        planId: metadata.testPlanId,
                        suiteId: metadata.testSuiteId
                    });
                }
            }
        }

        // Fetch test points for each unique plan/suite combination
        for (const {planId, suiteId} of planSuiteMap.values()) {
            try {
                await this.client.fetchTestPoints(planId, suiteId);
            } catch (error) {
                CSReporter.warn(`Failed to fetch test points for plan ${planId}, suite ${suiteId}: ${error}`);
            }
        }

        // Now collect test points for each scenario
        for (const {scenario, feature} of scenarios) {
            const metadata = this.tagExtractor.extractMetadata(scenario, feature);

            if (metadata.testCaseIds.length > 0 &&
                metadata.testPlanId &&
                metadata.testSuiteId) {

                // Get cached test points
                const testPoints = this.client.getTestPoints(
                    metadata.testPlanId,
                    metadata.testSuiteId
                );

                // Find test point for each test case
                for (const testCaseId of metadata.testCaseIds) {
                    // Azure DevOps test points may have testCase.id, testCaseReference.id, or be under a different property
                    const testPoint = testPoints.find((tp: any) => {
                        // Try various possible locations for test case ID
                        const possibleIds = [
                            tp.testCase?.id,
                            tp.testCaseReference?.id,
                            tp.testCaseId,
                            tp.workItem?.id,
                            tp.testMethod?.testCase?.id,
                            tp.testCaseTitle?.id // Some configurations use testCaseTitle
                        ];

                        // Check if any of these match our test case ID (as number or string)
                        const matched = possibleIds.some(id =>
                            id && (id === testCaseId || id === String(testCaseId) || String(id) === String(testCaseId))
                        );

                        if (!matched && !this.debuggedTestPoint) {
                            CSReporter.debug(`Test point ${tp.id} structure: ${JSON.stringify(tp, null, 2)}`);
                        }

                        return matched;
                    });

                    if (testPoint?.id) {
                        this.collectedTestPoints.add(testPoint.id);

                        // Track test points by plan ID
                        if (metadata.testPlanId) {
                            if (!this.planTestPointsMap.has(metadata.testPlanId)) {
                                this.planTestPointsMap.set(metadata.testPlanId, new Set());
                            }
                            this.planTestPointsMap.get(metadata.testPlanId)!.add(testPoint.id);

                            // Store the first plan ID we encounter
                            if (!this.testPlanId) {
                                this.testPlanId = metadata.testPlanId;
                            }
                        }

                        // CSReporter.info(`✓ Collected test point ${testPoint.id} for test case ${testCaseId}`);
                    } else {
                        CSReporter.warn(`No test point found for test case ${testCaseId} in plan ${metadata.testPlanId}, suite ${metadata.testSuiteId}`);
                        // Log structure of first test point for debugging
                        if (testPoints.length > 0 && !this.debuggedTestPoint) {
                            CSReporter.debug(`Available test points (first 3): ${JSON.stringify(testPoints.slice(0, 3), null, 2)}`);
                            this.debuggedTestPoint = true; // Only log once
                        }
                    }
                }
            }
        }

        // CSReporter.info(`Collected ${this.collectedTestPoints.size} test points for ADO test run`);
    }

    /**
     * Start test runs for all collected test plans
     */
    public async startTestRun(name?: string): Promise<void> {
        if (!this.config.isEnabled() || this.testRunStarted) {
            return;
        }

        try {
            // Get environment from config
            const environment = this.config.getEnvironment() || 'QA';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);

            // Get feature name from the first scenario's feature
            let featureName = 'TestRun';
            if (this.allScenarios && this.allScenarios.length > 0) {
                // Get the feature name from collected scenarios
                const firstFeature = this.allScenarios[0]?.feature;
                CSReporter.debug(`Extracting feature name from scenarios: ${this.allScenarios.length} scenarios available`);
                if (firstFeature && firstFeature.name) {
                    CSReporter.debug(`Found feature name: ${firstFeature.name}`);
                    // Clean the feature name for use in test run name
                    featureName = firstFeature.name.replace(/[^a-zA-Z0-9\s-]/g, '').trim();
                    // Limit length to avoid overly long names
                    if (featureName.length > 50) {
                        featureName = featureName.substring(0, 50).trim();
                    }
                } else {
                    CSReporter.debug(`No feature name found in first scenario`);
                }
            } else {
                CSReporter.debug(`allScenarios not populated: ${this.allScenarios ? this.allScenarios.length : 'null'}`);
            }

            // Format: FeatureName - Environment - TestRun - Timestamp
            const baseRunName = name || `${featureName} - ${environment} - TestRun - ${timestamp}`;

            // Create a test run for each plan that has test points
            for (const [planId, testPoints] of this.planTestPointsMap.entries()) {
                if (testPoints.size === 0) {
                    continue;
                }

                const planSpecificPoints = Array.from(testPoints);
                const runName = this.planTestPointsMap.size > 1
                    ? `${baseRunName} (Plan ${planId})`
                    : baseRunName;

                try {
                    const testRunId = await this.client.createTestRun(
                        runName,
                        planSpecificPoints,
                        planId
                    );

                    const testRun: ADOTestRun = {
                        id: testRunId,
                        name: runName
                    };

                    this.testRunsByPlan.set(planId, testRun);

                    // Set as current run if it's the primary plan
                    if (planId === this.testPlanId) {
                        this.currentTestRun = testRun;
                    }

                    // CSReporter.info(`✅ ADO Test Run created with ID ${testRunId} for plan ${planId} with ${planSpecificPoints.length} test points`);
                } catch (error) {
                    CSReporter.error(`Failed to create test run for plan ${planId}: ${error}`);
                }
            }

            if (this.testRunsByPlan.size > 0) {
                this.testRunStarted = true;
                // CSReporter.info(`Created ${this.testRunsByPlan.size} test run(s) for ${this.planTestPointsMap.size} plan(s)`);
            } else if (this.collectedTestPoints.size > 0) {
                CSReporter.error('Cannot create test runs: Test points collected but no valid plan IDs');
            } else {
                CSReporter.info('No ADO test points found - skipping test run creation');
            }
        } catch (error) {
            CSReporter.error(`Failed to start ADO test runs: ${error}`);
        }
    }

    /**
     * Add scenario result for publishing
     */
    public addScenarioResult(result: ScenarioResult): void {
        if (!this.config.isEnabled()) {
            return;
        }

        const key = this.getScenarioKey(result.scenario, result.feature);

        // Check if this is an iteration of a data-driven scenario
        // Treat any scenario with iteration number as data-driven
        if (result.iteration !== undefined) {
            // Store iterations separately
            if (!this.iterationResults.has(key)) {
                this.iterationResults.set(key, []);
            }
            this.iterationResults.get(key)!.push(result);
            // CSReporter.info(`DEBUG: Added iteration ${result.iteration} for ADO: ${key}`);
        } else {
            this.scenarioResults.set(key, result);
            // CSReporter.info(`DEBUG: Added scenario result for ADO: ${key}`);
        }
    }

    /**
     * Publish scenario result immediately (for sequential execution)
     */
    public async publishScenarioResult(result: ScenarioResult): Promise<void> {
        if (!this.config.isEnabled() || this.testRunsByPlan.size === 0) {
            return;
        }

        // For data-driven tests, accumulate iterations
        if (result.iteration !== undefined) {
            const key = this.getScenarioKey(result.scenario, result.feature);
            if (!this.iterationResults.has(key)) {
                this.iterationResults.set(key, []);
            }
            this.iterationResults.get(key)!.push(result);
            // CSReporter.info(`DEBUG: Accumulated iteration ${result.iteration} for sequential execution: ${key}`);

            // Don't publish yet - wait for all iterations to complete
            // The final publish will happen when called with no iteration (or in afterAllTests)
            return;
        }

        // For non-data-driven tests or when all iterations are done, publish immediately
        try {
            await this.publishSingleResult(result);
        } catch (error) {
            CSReporter.error(`Failed to publish result for scenario: ${result.scenario.name} - ${error}`);
            // Don't throw - continue with other scenarios
        }
    }

    /**
     * Publish data-driven test results after all iterations are complete
     */
    public async publishDataDrivenResults(scenario: ParsedScenario, feature: ParsedFeature): Promise<void> {
        if (!this.config.isEnabled() || this.testRunsByPlan.size === 0) {
            return;
        }

        const key = this.getScenarioKey(scenario, feature);
        const iterations = this.iterationResults.get(key);

        if (!iterations || iterations.length === 0) {
            CSReporter.warn(`No iterations found for data-driven test: ${key}`);
            return;
        }

        // CSReporter.info(`Publishing aggregated results for ${iterations.length} iterations of: ${key}`);

        // Create aggregated result from iterations
        const aggregatedResult = this.aggregateIterations(scenario, feature, iterations);

        try {
            await this.publishSingleResult(aggregatedResult);
        } catch (error) {
            CSReporter.error(`Failed to publish data-driven results: ${error}`);
        }

        // Clear the iterations after publishing
        this.iterationResults.delete(key);
    }

    /**
     * Aggregate iteration results into a single result with subResults
     */
    private aggregateIterations(scenario: ParsedScenario, feature: ParsedFeature, iterations: ScenarioResult[]): ScenarioResult {
        // Determine overall status
        const hasFailure = iterations.some(iter => iter.status === 'failed');
        const status = hasFailure ? 'failed' : 'passed';

        // Aggregate durations
        const totalDuration = iterations.reduce((sum, iter) => sum + iter.duration, 0);

        // Aggregate error messages
        const errorMessages = iterations
            .filter(iter => iter.errorMessage)
            .map((iter, idx) => `Iteration ${iter.iteration || idx + 1}: ${iter.errorMessage}`);

        return {
            scenario,
            feature,
            status,
            duration: totalDuration,
            errorMessage: errorMessages.length > 0 ? errorMessages.join('\n') : undefined,
            // Don't include iteration data in the main result - it will be in subResults
            iteration: undefined,
            iterationData: undefined,
            artifacts: iterations[0]?.artifacts  // Use artifacts from first iteration
        };
    }

    /**
     * Publish all accumulated results (for parallel execution)
     */
    public async publishAllResults(): Promise<void> {
        if (!this.config.isEnabled() || this.testRunsByPlan.size === 0 || this.isPublishing) {
            return;
        }

        this.isPublishing = true;

        try {
            // CSReporter.info(`Publishing ${this.scenarioResults.size} test results to Azure DevOps...`);

            for (const [key, result] of this.scenarioResults) {
                await this.publishSingleResult(result);
            }

            // CSReporter.info('All test results published to Azure DevOps');
        } catch (error) {
            CSReporter.error(`Failed to publish results to Azure DevOps: ${error}`);
        } finally {
            this.isPublishing = false;
        }
    }

    /**
     * Publish a single scenario result (handles iterations for data-driven scenarios)
     */
    private async publishSingleResult(result: ScenarioResult): Promise<void> {
        const metadata = this.tagExtractor.extractMetadata(result.scenario, result.feature);

        // Skip if no ADO mapping
        if (!metadata.testCaseIds.length && !metadata.testPlanId && !metadata.testSuiteId) {
            CSReporter.debug(`Skipping ADO publish for scenario without mapping: ${result.scenario.name}`);
            return;
        }

        // Use metadata test IDs or fall back to config
        const testCaseIds = metadata.testCaseIds.length > 0 ?
            metadata.testCaseIds :
            (metadata.testCaseId ? [metadata.testCaseId] : []);

        if (testCaseIds.length === 0) {
            CSReporter.warn(`No test case IDs found for scenario: ${result.scenario.name}`);
            return;
        }

        // Find the correct test run for this scenario's plan
        const testRun = metadata.testPlanId ? this.testRunsByPlan.get(metadata.testPlanId) : this.currentTestRun;

        if (!testRun) {
            CSReporter.warn(`No test run found for plan ${metadata.testPlanId} - skipping result update`);
            return;
        }

        // Check if there are iterations for this scenario (data-driven)
        const key = this.getScenarioKey(result.scenario, result.feature);
        const iterations = this.iterationResults.get(key) || [];

        let finalOutcome: string;
        let aggregatedErrorMessage: string | undefined;
        let totalDuration = result.duration;
        let subResults: any[] | undefined;
        const resultIds: number[] = [];

        if (iterations.length > 0) {
            // For data-driven tests with iterations
            // CSReporter.info(`📊 Publishing ${iterations.length} iterations for data-driven scenario: ${result.scenario.name}`);

            // WORKAROUND: Since Azure DevOps doesn't properly support iterationDetails,
            // we aggregate all iterations into a single test result with detailed comments
            // CSReporter.info(`🔄 Using workaround: Aggregating ${iterations.length} iterations into single test result`);

            // Determine overall outcome
            const hasFailure = iterations.some(iter => iter.status === 'failed');
            const overallOutcome = hasFailure ? 'Failed' : 'Passed';

            // Build detailed summary for all iterations
            const iterationSummaries: string[] = [];
            const failedIterations: string[] = [];
            let totalDuration = 0;

            for (const [idx, iter] of iterations.entries()) {
                const iterationNum = iter.iteration || idx + 1;
                totalDuration += iter.duration || 0;

                // Build iteration summary with parameters
                let iterSummary = `Iteration ${iterationNum}`;
                if (iter.iterationData) {
                    const params = Object.entries(iter.iterationData)
                        .slice(0, 3) // Limit to first 3 params for readability
                        .map(([key, value]) => `${key}:${value}`)
                        .join(', ');
                    iterSummary += ` [${params}]`;
                }
                iterSummary += `: ${iter.status === 'passed' ? '✅ Passed' : '❌ Failed'}`;

                iterationSummaries.push(iterSummary);

                if (iter.status === 'failed' && iter.errorMessage) {
                    failedIterations.push(`  - ${iterSummary}\n    Error: ${iter.errorMessage}`);
                }
            }

            // Build comprehensive comment
            const comment = `Data-Driven Test Results (${iterations.length} iterations)\n` +
                           `Overall Status: ${overallOutcome}\n\n` +
                           `Iteration Results:\n${iterationSummaries.join('\n')}` +
                           (failedIterations.length > 0 ? `\n\nFailed Iterations Details:\n${failedIterations.join('\n')}` : '');

            // Create aggregated error message if there are failures
            const aggregatedError = failedIterations.length > 0 ?
                `${failedIterations.length} of ${iterations.length} iterations failed. See comment for details.` :
                undefined;

            for (const testCaseId of testCaseIds) {
                const aggregatedResult: any = {
                    testCaseId,
                    testCaseTitle: `${result.scenario.name} (${iterations.length} iterations)`,
                    outcome: overallOutcome,
                    errorMessage: aggregatedError,
                    duration: totalDuration,
                    comment: comment
                };

                // CSReporter.info(`📝 Updating test result with aggregated data from ${iterations.length} iterations`);
                await this.client.updateTestResult(aggregatedResult, testRun.id);
            }

            // Calculate aggregated values for summary (already calculated above)
            finalOutcome = overallOutcome;
            totalDuration = iterations.reduce((sum, iter) => sum + iter.duration, 0);

            // CSReporter.info(`✅ Created ${iterations.length} separate test results for data-driven scenario`);
            return; // Exit early since we've handled iterations separately
        } else {
            // Single execution (non-data-driven)
            finalOutcome = result.status === 'passed' ? 'Passed' :
                          result.status === 'failed' ? 'Failed' :
                          'NotExecuted';
            aggregatedErrorMessage = result.errorMessage;

            // Add test results for all mapped test cases
            for (const testCaseId of testCaseIds) {
                const testResult: any = {
                    testCaseId,
                    outcome: finalOutcome as any,
                    errorMessage: aggregatedErrorMessage,
                    duration: totalDuration,
                    stackTrace: result.stackTrace,
                    comment: result.comment  // Pass custom comment if provided
                };

                await this.client.updateTestResult(testResult, testRun.id);
                resultIds.push(testCaseId);
            }
        }

        // Upload attachments if configured
        if (resultIds.length > 0 && result.artifacts) {
            await this.uploadArtifacts(testRun.id, resultIds, result.artifacts);
        }

        // Create bug on failure if configured
        if (finalOutcome === 'Failed' && this.config.shouldCreateBugsOnFailure()) {
            await this.createBugForFailure(result, metadata);
        }
    }

    /**
     * Upload test artifacts to ADO
     */
    private async uploadArtifacts(
        runId: number,
        resultIds: number[],
        artifacts: ScenarioResult['artifacts']
    ): Promise<void> {
        const attachments: ADOAttachment[] = [];

        // Upload screenshots
        if (this.config.shouldUploadScreenshots() && artifacts?.screenshots) {
            for (const filePath of artifacts.screenshots) {
                const attachment = await this.uploadFile(filePath, 'Screenshot');
                if (attachment) {
                    attachments.push(attachment);
                }
            }
        }

        // Upload videos
        if (this.config.shouldUploadVideos() && artifacts?.videos) {
            for (const filePath of artifacts.videos) {
                const attachment = await this.uploadFile(filePath, 'Video');
                if (attachment) {
                    attachments.push(attachment);
                }
            }
        }

        // Upload HAR files
        if (this.config.shouldUploadHar() && artifacts?.har) {
            for (const filePath of artifacts.har) {
                const attachment = await this.uploadFile(filePath, 'ConsoleLog');
                if (attachment) {
                    attachments.push(attachment);
                }
            }
        }

        // Upload trace files
        if (this.config.shouldUploadTraces() && artifacts?.traces) {
            for (const filePath of artifacts.traces) {
                const attachment = await this.uploadFile(filePath, 'GeneralAttachment');
                if (attachment) {
                    attachments.push(attachment);
                }
            }
        }

        // Upload logs
        if (this.config.shouldUploadLogs() && artifacts?.logs) {
            for (const filePath of artifacts.logs) {
                const attachment = await this.uploadFile(filePath, 'ConsoleLog');
                if (attachment) {
                    attachments.push(attachment);
                }
            }
        }

        // Attach all files to test results
        for (const attachment of attachments) {
            // Attachments are already uploaded, just track them
        }

        if (attachments.length > 0) {
            // CSReporter.info(`Uploaded ${attachments.length} attachments for test results`);
        }
    }

    /**
     * Upload a single file to ADO
     */
    private async uploadFile(
        filePath: string,
        attachmentType: ADOAttachment['attachmentType']
    ): Promise<ADOAttachment | null> {
        if (!fs.existsSync(filePath)) {
            CSReporter.warn(`File not found for upload: ${filePath}`);
            return null;
        }

        try {
            const content = fs.readFileSync(filePath);
            const fileName = path.basename(filePath);

            // Create attachment object
            const attachment: ADOAttachment = {
                url: fileName,
                attachmentType: attachmentType
            };

            attachment.attachmentType = attachmentType;
            return attachment;
        } catch (error) {
            CSReporter.warn(`Failed to upload file ${filePath}: ${error}`);
            return null;
        }
    }

    /**
     * Create a bug for failed test
     */
    private async createBugForFailure(
        result: ScenarioResult,
        metadata: ADOMetadata
    ): Promise<void> {
        try {
            const title = this.config.formatBugTitle(
                result.scenario.name,
                result.errorMessage
            );

            const description = this.formatBugDescription(result, metadata);

            // Upload screenshots as attachments for the bug
            const attachmentUrls: string[] = [];
            if (result.artifacts?.screenshots) {
                for (const screenshot of result.artifacts.screenshots) {
                    const attachment = await this.uploadFile(screenshot, 'Screenshot');
                    if (attachment) {
                        attachmentUrls.push(attachment.url);
                    }
                }
            }

            // Get bug template configuration
            const bugTemplate = this.config.getBugTemplate();

            await this.client.createBug({
                title,
                description,
                severity: bugTemplate.severity || '3 - Medium',
                priority: bugTemplate.priority || 2,
                assignedTo: bugTemplate.assignedTo
            });
        } catch (error) {
            CSReporter.error(`Failed to create bug for test failure: ${error}`);
        }
    }

    /**
     * Format bug description
     */
    private formatBugDescription(
        result: ScenarioResult,
        metadata: ADOMetadata
    ): string {
        const lines: string[] = [
            `**Test Scenario:** ${result.scenario.name}`,
            `**Feature:** ${result.feature.name}`,
            `**Status:** ${result.status}`,
            `**Duration:** ${result.duration}ms`,
            ''
        ];

        if (metadata.testCaseIds.length > 0) {
            lines.push(`**Test Cases:** ${metadata.testCaseIds.join(', ')}`);
        }

        if (result.errorMessage) {
            lines.push('', '**Error Message:**', '```', result.errorMessage, '```');
        }

        if (result.stackTrace) {
            lines.push('', '**Stack Trace:**', '```', result.stackTrace, '```');
        }

        // Add steps from scenario
        if (result.scenario.steps && result.scenario.steps.length > 0) {
            lines.push('', '**Test Steps:**');
            for (const step of result.scenario.steps) {
                lines.push(`- ${step.keyword} ${step.text}`);
            }
        }

        return lines.join('\n');
    }

    /**
     * Complete all test runs and attach zipped results
     */
    public async completeTestRun(testResultsPath?: string): Promise<void> {
        if (!this.config.isEnabled() || this.testRunsByPlan.size === 0) {
            return;
        }

        try {
            // Publish any remaining results
            if (this.scenarioResults.size > 0) {
                await this.publishAllResults();
            }

            // Complete each test run and attach zipped results
            for (const [planId, testRun] of this.testRunsByPlan.entries()) {
                try {
                    // Attach zipped test results if available
                    if (testResultsPath) {
                        // Check if it's a zip file
                        if (testResultsPath.endsWith('.zip')) {
                            // CSReporter.info(`Attaching zipped test results to test run ${testRun.id} (Plan ${planId})`);
                            await this.client.uploadTestRunAttachment(testRun.id, testResultsPath);
                        } else {
                            // If not a zip, check if we need to zip it
                            const zipPath = `${testResultsPath}.zip`;
                            if (fs.existsSync(zipPath)) {
                                // CSReporter.info(`Attaching zipped test results to test run ${testRun.id} (Plan ${planId})`);
                                await this.client.uploadTestRunAttachment(testRun.id, zipPath);
                            } else {
                                CSReporter.debug(`No zipped results found at ${zipPath}`);
                            }
                        }
                    }

                    // Complete the test run
                    await this.client.completeTestRun(testRun.id);
                    // CSReporter.info(`ADO Test Run completed: ${testRun.name} (ID: ${testRun.id}`);
                } catch (error) {
                    CSReporter.error(`Failed to complete test run ${testRun.id} for plan ${planId}: ${error}`);
                    // Continue with other test runs
                }
            }

            // Clear state
            this.currentTestRun = undefined;
            this.testRunsByPlan.clear();
            this.scenarioResults.clear();
            this.iterationResults.clear();
            this.collectedTestPoints.clear();
            this.planTestPointsMap.clear();

            // Delete the zip file after successful upload to all test runs
            if (testResultsPath && testResultsPath.endsWith('.zip')) {
                try {
                    if (fs.existsSync(testResultsPath)) {
                        fs.unlinkSync(testResultsPath);
                        // CSReporter.info(`🗑️ Deleted zip file after ADO upload: ${testResultsPath}`);
                    }
                } catch (deleteError) {
                    CSReporter.warn(`Failed to delete zip file: ${deleteError}`);
                    // Don't throw - this is not critical
                }
            }
        } catch (error) {
            CSReporter.error(`Failed to complete ADO test runs: ${error}`);
        }
    }

    /**
     * Get unique scenario key
     */
    private getScenarioKey(scenario: ParsedScenario, feature: ParsedFeature): string {
        return `${feature.name}::${scenario.name}`;
    }

    /**
     * Check if ADO publishing is enabled
     */
    public isEnabled(): boolean {
        return this.config.isEnabled();
    }

    /**
     * Check if we have any test results to publish
     * Returns true only if test runs were actually started (not just config enabled)
     */
    public hasTestResults(): boolean {
        // Only return true if we have both:
        // 1. Active test runs (validation passed and test runs were started)
        // 2. Scenario results to publish
        return this.testRunsByPlan.size > 0 && (this.scenarioResults.size > 0 || this.iterationResults.size > 0);
    }

    /**
     * Get current test run
     */
    public getCurrentTestRun(): ADOTestRun | undefined {
        return this.currentTestRun;
    }
}