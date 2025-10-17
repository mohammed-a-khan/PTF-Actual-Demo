/**
 * CS Playwright Test Framework - Performance Testing Entry Point
 *
 * Dedicated export file for performance testing module
 * Import this for performance testing only:
 *
 * @example
 * import { CSPerformanceSteps, CSLoadGenerator } from '@mdakhan.mak/cs-playwright-test-framework/performance';
 */

// Performance Testing Core
export { CSLoadGenerator } from '../performance/CSLoadGenerator';
export { CSPerformanceTestRunner } from '../performance/CSPerformanceTestRunner';
export { CSPerformanceReporter } from '../performance/CSPerformanceReporter';

// Performance Scenarios
export {
    CSLoadTestScenario,
    CSStressTestScenario,
    CSSpikeTestScenario,
    CSEnduranceTestScenario,
    CSBaselineTestScenario,
    CSCoreWebVitalsScenario,
    CSPageLoadPerformanceScenario,
    CSUILoadTestScenario,
    CSVisualRegressionPerformanceScenario
} from '../performance/scenarios/CSPerformanceScenario';

// Performance Types
export * from '../performance/types/CSPerformanceTypes';

// Performance BDD Steps
export { CSPerformanceSteps } from '../steps/performance/CSPerformanceSteps';

// Essential Dependencies (needed for performance testing)
export { CSBDDStepDef } from '../bdd/CSStepRegistry';
export { CSReporter } from '../reporter/CSReporter';
export { CSConfigurationManager } from '../core/CSConfigurationManager';

// Performance Monitoring
export { CSPerformanceMonitor } from '../monitoring/CSPerformanceMonitor';
