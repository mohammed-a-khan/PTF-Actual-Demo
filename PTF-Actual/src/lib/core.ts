/**
 * CS Playwright Test Framework - Core Entry Point
 *
 * Only exports core framework modules
 *
 * @example
 * import { CSBasePage, CSPageFactory } from '@mdakhan.mak/cs-playwright-test-framework/core';
 */

// Core Framework
export { CSBasePage } from '../core/CSBasePage';
export { CSConfigurationManager } from '../core/CSConfigurationManager';
export { CSPageFactory, CSPage, CSGetElement, CSGetElements, CSElement, CSElements } from '../core/CSPageFactory';
export { CSStepLoader } from '../core/CSStepLoader';
export { CSModuleDetector } from '../core/CSModuleDetector';
