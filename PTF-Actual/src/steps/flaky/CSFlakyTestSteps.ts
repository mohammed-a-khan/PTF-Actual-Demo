/**
 * CSFlakyTestSteps - BDD Step Definitions for Flaky Test Detection
 *
 * Provides Gherkin step definitions for asserting test flakiness,
 * quarantine status, report generation, and data maintenance.
 *
 * @module steps/flaky
 */

import { CSBDDStepDef } from '../../bdd/CSStepRegistry';
import { CSReporter } from '../../reporter/CSReporter';
import { CSFlakyTestDetector } from '../../flaky/CSFlakyTestDetector';

export class CSFlakyTestSteps {
    private static detector: CSFlakyTestDetector = CSFlakyTestDetector.getInstance();

    // ==========================================================================
    // THEN STEPS - Assertions
    // ==========================================================================

    /**
     * Assert that a specific test's flakiness score is below a threshold.
     * Usage: Then test "login-test-001" should have flakiness score below 15
     */
    @CSBDDStepDef('test {string} should have flakiness score below {int}')
    static assertFlakinessScoreBelow(testId: string, maxScore: number): void {
        const score = CSFlakyTestSteps.detector.getFlakinessScore(testId);
        CSReporter.info(`[FlakySteps] Test "${testId}" flakiness score: ${score} (threshold: ${maxScore})`);
        if (score >= maxScore) {
            throw new Error(
                `Test "${testId}" has flakiness score ${score}, which is not below the expected threshold of ${maxScore}.`
            );
        }
    }

    /**
     * Assert that no tests are currently quarantined.
     * Usage: Then no tests should be quarantined
     */
    @CSBDDStepDef('no tests should be quarantined')
    static assertNoQuarantinedTests(): void {
        const quarantined = CSFlakyTestSteps.detector.getQuarantinedTests();
        CSReporter.info(`[FlakySteps] Quarantined tests count: ${quarantined.length}`);
        if (quarantined.length > 0) {
            const names = quarantined.map(q => `${q.testId} (score: ${q.record.flakinessScore})`).join(', ');
            throw new Error(
                `Expected no quarantined tests but found ${quarantined.length}: ${names}`
            );
        }
    }

    /**
     * Assert overall flaky test health.
     * Usage: Then the flakiness report should show 5 flaky tests or fewer
     */
    @CSBDDStepDef('the flakiness report should show {int} flaky tests or fewer')
    static assertFlakyTestCount(maxFlaky: number): void {
        const report = CSFlakyTestSteps.detector.generateFlakinessReport();
        CSReporter.info(`[FlakySteps] Flaky tests: ${report.flakyTests} (max allowed: ${maxFlaky})`);
        if (report.flakyTests > maxFlaky) {
            throw new Error(
                `Expected ${maxFlaky} or fewer flaky tests but found ${report.flakyTests}. ` +
                `Average flakiness score: ${report.averageFlakinessScore}.`
            );
        }
    }

    // ==========================================================================
    // WHEN STEPS - Actions
    // ==========================================================================

    /**
     * Generate and log the flakiness report.
     * Usage: When I generate flakiness report
     */
    @CSBDDStepDef('I generate flakiness report')
    static generateReport(): void {
        const report = CSFlakyTestSteps.detector.generateFlakinessReport();
        CSReporter.info(`[FlakySteps] Flakiness Report Generated at ${report.generatedAt}`);
        CSReporter.info(`[FlakySteps]   Total tests:      ${report.totalTests}`);
        CSReporter.info(`[FlakySteps]   Flaky tests:      ${report.flakyTests}`);
        CSReporter.info(`[FlakySteps]   Quarantined:      ${report.quarantinedTests}`);
        CSReporter.info(`[FlakySteps]   Stable tests:     ${report.stableTests}`);
        CSReporter.info(`[FlakySteps]   Avg score:        ${report.averageFlakinessScore}`);

        for (const test of report.tests) {
            if (test.score > 0) {
                CSReporter.info(
                    `[FlakySteps]   - ${test.testName}: score=${test.score}, pattern=${test.pattern}, ` +
                    `recommendation=${test.recommendation}`
                );
            }
        }
    }

    /**
     * Clean up old flaky test data.
     * Usage: When I cleanup flaky test data older than 30 days
     */
    @CSBDDStepDef('I cleanup flaky test data older than {int} days')
    static cleanupData(days: number): void {
        CSReporter.info(`[FlakySteps] Cleaning up flaky test data older than ${days} days`);
        CSFlakyTestSteps.detector.cleanup(days);
    }
}
