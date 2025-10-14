/**
 * CS Playwright Test Framework - BDD Entry Point
 *
 * Lightweight entry point for BDD testing
 * Use this instead of the main entry point for faster imports:
 *
 * @example
 * // Fast (25ms):
 * import { CSBDDStepDef, Page, StepDefinitions } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
 *
 * // Slow (34s):
 * import { CSBDDStepDef, Page, StepDefinitions } from '@mdakhan.mak/cs-playwright-test-framework';
 */

// Core Framework (needed for BDD)
export { CSConfigurationManager } from '../core/CSConfigurationManager';
export { CSBasePage } from '../core/CSBasePage';
export { CSPageFactory, CSPage, CSGetElement, CSGetElements, CSElement, CSElements } from '../core/CSPageFactory';

// BDD & Testing
export { CSBDDRunner } from '../bdd/CSBDDRunner';
export { CSBDDEngine } from '../bdd/CSBDDEngine';
export { CSStepRegistry, CSBDDStepDef } from '../bdd/CSStepRegistry';
export { simpleStepRegistry } from '../bdd/CSSimpleStepRegistry';
export { CSScenarioContext } from '../bdd/CSScenarioContext';
export { CSFeatureContext } from '../bdd/CSFeatureContext';
export { CSBDDContext } from '../bdd/CSBDDContext';
export { CSDataSource } from '../bdd/CSDataSourceDecorator';
export { CSStepValidator } from '../bdd/CSStepValidator';
export * from '../bdd/CSBDDDecorators';

// Cucumber-Compatible Decorators
export { Given, When, Then, And, But, Step, defineStep } from '../bdd/CSCucumberDecorators';

// Elements & Browser
export { CSWebElement } from '../element/CSWebElement';
export { CSElementResolver } from '../element/CSElementResolver';
export { CSBrowserPool } from '../browser/CSBrowserPool';
export { CSBrowserManager } from '../browser/CSBrowserManager';

// Reporting (needed for tests)
export { CSReporter } from '../reporter/CSReporter';

// Assertions
export { CSAssert } from '../assertions/CSAssert';
export { CSExpect } from '../assertions/CSExpect';

// Utilities
export { CSValueResolver } from '../utils/CSValueResolver';
export { CSEncryptionUtil } from '../utils/CSEncryptionUtil';

// Data Management
export { CSDataProvider } from '../data/CSDataProvider';
export { CSDataGenerator } from '../data/CSDataGenerator';

// Diagnostics
export { CSPageDiagnostics } from '../diagnostics/CSPageDiagnostics';
export type { PageDiagnosticData, DiagnosticConsoleLog, DiagnosticError, DiagnosticRequest, DiagnosticOptions } from '../diagnostics/CSPageDiagnostics';
