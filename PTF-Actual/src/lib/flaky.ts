/**
 * CS Playwright Test Framework - Flaky Test Detection Entry Point
 *
 * Exports the Smart Flaky Test Detection module for detecting,
 * analyzing, and quarantining intermittent test failures.
 *
 * @example
 * import { CSFlakyTestDetector } from '@mdakhan.mak/cs-playwright-test-framework/flaky';
 */

export { CSFlakyTestDetector } from '../flaky/CSFlakyTestDetector';
export * from '../flaky/CSFlakyTestTypes';
export { CSFlakyTestSteps } from '../steps/flaky/CSFlakyTestSteps';
