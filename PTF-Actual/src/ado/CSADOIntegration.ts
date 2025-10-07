/**
 * Azure DevOps Integration Hook
 * Integrates ADO publishing with the BDD test runner
 */

import { CSADOPublisher, ScenarioResult } from './CSADOPublisher';
import { CSADOTagExtractor } from './CSADOTagExtractor';
import { CSReporter } from '../reporter/CSReporter';
import { ParsedScenario, ParsedFeature } from '../bdd/CSBDDEngine';
import { CSTestResultsManager } from '../reporter/CSTestResultsManager';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

export class CSADOIntegration {
    private static instance: CSADOIntegration;
    private publisher: CSADOPublisher;
    private tagExtractor: CSADOTagExtractor;
    private isInitialized: boolean = false;
    private isParallelMode: boolean = false;
    private allScenarios: Array<{scenario: ParsedScenario, feature: ParsedFeature}> = [];
    private resultsManager: CSTestResultsManager;
    private config: CSConfigurationManager;

    private constructor() {
        this.publisher = CSADOPublisher.getInstance();
        this.tagExtractor = CSADOTagExtractor.getInstance();
        this.resultsManager = CSTestResultsManager.getInstance();
        this.config = CSConfigurationManager.getInstance();
    }

    public static getInstance(): CSADOIntegration {
        if (!CSADOIntegration.instance) {
            CSADOIntegration.instance = new CSADOIntegration();
        }
        return CSADOIntegration.instance;
    }

    /**
     * Get the publisher instance for direct access
     */
    public getPublisher(): CSADOPublisher {
        return this.publisher;
    }

    /**
     * Initialize ADO integration
     */
    public async initialize(isParallel: boolean = false): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        this.isParallelMode = isParallel;
        await this.publisher.initialize();
        this.isInitialized = true;

        if (this.publisher.isEnabled()) {
            // CSReporter.info('Azure DevOps integration enabled');
        }
    }

    /**
     * Validate ADO configuration for the test run
     * Returns true if ADO should be enabled, false otherwise
     */
    private validateADOConfiguration(scenarios: Array<{scenario: ParsedScenario, feature: ParsedFeature}>): boolean {
        if (!this.publisher.isEnabled()) {
            return false;
        }

        // Check if at least one scenario has test case IDs
        let hasTestCases = false;
        let hasValidPlanSuite = false;
        const missingPlanSuite: string[] = [];

        for (const {scenario, feature} of scenarios) {
            const metadata = this.tagExtractor.extractMetadata(scenario, feature);

            if (metadata.testCaseIds.length > 0) {
                hasTestCases = true;

                if (!metadata.testPlanId || !metadata.testSuiteId) {
                    missingPlanSuite.push(`${scenario.name} (Plan: ${metadata.testPlanId || 'missing'}, Suite: ${metadata.testSuiteId || 'missing'})`);
                } else {
                    hasValidPlanSuite = true;
                }
            }
        }

        // Validate: Must have at least one test case
        if (!hasTestCases) {
            CSReporter.warn('⚠️ ADO Integration disabled: No scenarios have @TestCaseId tags');
            CSReporter.warn('Add @TestCaseId tags to scenarios to enable ADO integration');
            return false;
        }

        // Validate: Must have valid plan/suite for test cases
        if (!hasValidPlanSuite && missingPlanSuite.length > 0) {
            CSReporter.error('❌ ADO Integration disabled: Test cases found but no valid Plan/Suite IDs');
            CSReporter.error('Missing Plan or Suite IDs for scenarios:');
            missingPlanSuite.forEach(s => CSReporter.error(`  - ${s}`));
            CSReporter.error('Add @TestPlanId and @TestSuiteId tags or set ADO_TEST_PLAN_ID and ADO_TEST_SUITE_ID in config');
            return false;
        }

        if (missingPlanSuite.length > 0) {
            CSReporter.warn('⚠️ Some scenarios have test cases but missing Plan/Suite IDs:');
            missingPlanSuite.forEach(s => CSReporter.warn(`  - ${s}`));
        }

        // CSReporter.info('✅ ADO configuration validated successfully');
        return true;
    }

    /**
     * Collect all scenarios that will be executed
     * This should be called before test execution starts
     */
    public async collectScenarios(scenarios: Array<{scenario: ParsedScenario, feature: ParsedFeature}>): Promise<void> {
        this.allScenarios = scenarios;

        // Validate configuration before collecting test points
        if (this.publisher.isEnabled()) {
            if (!this.validateADOConfiguration(scenarios)) {
                // Disable ADO for this run by not collecting test points
                CSReporter.warn('Skipping ADO test point collection due to configuration issues');
                return;
            }

            // Collect test points from all scenarios
            await this.publisher.collectTestPoints(scenarios);
        }
    }

    /**
     * Called before test execution starts
     */
    public async beforeAllTests(testRunName?: string): Promise<void> {
        if (!this.publisher.isEnabled()) {
            return;
        }

        try {
            // Start test run with the collected test points
            await this.publisher.startTestRun(testRunName);
        } catch (error) {
            CSReporter.error(`Failed to start ADO test run: ${error}`);
        }
    }

    /**
     * Called before a scenario executes
     */
    public beforeScenario(scenario: ParsedScenario, feature: ParsedFeature): void {
        if (!this.publisher.isEnabled()) {
            return;
        }

        // Extract ADO metadata from tags
        const metadata = this.tagExtractor.extractMetadata(scenario, feature);

        // Log if scenario has ADO mapping
        if (metadata.testCaseIds.length > 0) {
            // CSReporter.info(`Scenario mapped to ADO test cases: ${metadata.testCaseIds.join(', ')}`);
        }
    }

    /**
     * Called after a scenario completes
     */
    public async afterScenario(
        scenario: ParsedScenario,
        feature: ParsedFeature,
        status: 'passed' | 'failed' | 'skipped' | 'completed',
        duration: number,
        errorMessage?: string,
        artifacts?: any,
        stackTrace?: string,
        iterationNumber?: number,
        iterationData?: any,
        comment?: string  // Add comment parameter for aggregated results
    ): Promise<void> {
        if (!this.publisher.isEnabled()) {
            return;
        }

        // Special handling for data-driven test completion signal
        if (status === 'completed') {
            // This signals that all iterations are done, publish the aggregated results
            await this.publisher.publishDataDrivenResults(scenario, feature);
            return;
        }

        const result: ScenarioResult = {
            scenario,
            feature,
            status: status as 'passed' | 'failed' | 'skipped',
            duration,
            errorMessage,
            stackTrace,
            artifacts,
            iteration: iterationNumber,
            iterationData,
            comment  // Pass the comment to the result
        };

        if (this.isParallelMode) {
            // In parallel mode, accumulate results for batch publishing
            this.publisher.addScenarioResult(result);
        } else {
            // In sequential mode, publish immediately
            await this.publisher.publishScenarioResult(result);
        }
    }

    /**
     * Called after all tests complete
     */
    public async afterAllTests(): Promise<void> {
        if (!this.publisher.isEnabled()) {
            return;
        }

        try {
            // In parallel mode, publish all accumulated results
            if (this.isParallelMode) {
                await this.publisher.publishAllResults();
            }

            // Only create zip and complete test run if we actually have ADO test cases
            if (this.publisher.hasTestResults()) {
                // For ADO, create a zip file for attachment when we have test results
                // CSReporter.info('Creating test results zip for ADO attachment...');
                const testResultsPath = await this.resultsManager.createTestResultsZip();

                // Complete the test run with results attachment
                await this.publisher.completeTestRun(testResultsPath);
            }
        } catch (error) {
            CSReporter.error(`Failed to complete ADO test run: ${error}`);
        }
    }

    /**
     * Check if a scenario has ADO mapping
     */
    public hasADOMapping(scenario: ParsedScenario, feature: ParsedFeature): boolean {
        return this.tagExtractor.hasADOMapping(scenario, feature);
    }

    /**
     * Get ADO metadata for a scenario
     */
    public getADOMetadata(scenario: ParsedScenario, feature: ParsedFeature) {
        return this.tagExtractor.extractMetadata(scenario, feature);
    }

    /**
     * Create result object from worker result (for parallel execution)
     */
    public createScenarioResultFromWorker(
        workerResult: any,
        scenario: ParsedScenario,
        feature: ParsedFeature
    ): ScenarioResult {
        return {
            scenario,
            feature,
            status: workerResult.status || 'skipped',
            duration: workerResult.duration || 0,
            errorMessage: workerResult.error,
            artifacts: workerResult.artifacts,
            iteration: workerResult.iterationNumber,
            iterationData: workerResult.iterationData
        };
    }

    /**
     * Check if ADO integration is enabled
     */
    public isEnabled(): boolean {
        return this.publisher.isEnabled();
    }
}