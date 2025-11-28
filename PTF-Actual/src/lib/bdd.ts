/**
 * CS Playwright Test Framework - BDD Entry Point
 *
 * Only exports BDD-specific modules
 * For other dependencies, import them directly from their specific entry points
 *
 * @example
 * import { CSBDDStepDef, StepDefinitions } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
 */

// BDD Core
export { CSBDDRunner } from '../bdd/CSBDDRunner';
export { CSBDDEngine } from '../bdd/CSBDDEngine';
export { CSStepRegistry, CSBDDStepDef } from '../bdd/CSStepRegistry';
export { simpleStepRegistry } from '../bdd/CSSimpleStepRegistry';
export { CSScenarioContext } from '../bdd/CSScenarioContext';
export { CSFeatureContext } from '../bdd/CSFeatureContext';
export { CSBDDContext } from '../bdd/CSBDDContext';
export { CSDataSource } from '../bdd/CSDataSourceDecorator';
export { CSStepValidator } from '../bdd/CSStepValidator';
export { CSIntelligentStepExecutor } from '../bdd/CSIntelligentStepExecutor';
export { CSStepPatternScanner } from '../bdd/CSStepPatternScanner';
export * from '../bdd/CSBDDDecorators';

//BDD Types (lightweight - can be imported without loading heavy modules)
export type {
    ParsedFeature,
    ParsedScenario,
    ParsedStep,
    ParsedBackground,
    ParsedRule,
    ParsedExamples,
    ExternalDataSource
} from '../bdd/CSBDDTypes';

// Cucumber-Compatible Decorators
export { Given, When, Then, And, But, Step, defineStep } from '../bdd/CSCucumberDecorators';
