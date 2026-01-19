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
export { CSFramePage } from '../core/CSFramePage';
export type { FrameSelector } from '../core/CSFramePage';
export { CSConfigurationManager } from '../core/CSConfigurationManager';
export { CSPageFactory, CSPage, CSGetElement, CSGetElements, CSElement, CSElements, CSIframe } from '../core/CSPageFactory';
export { CSPageRegistry } from '../core/CSPageRegistry';
export { CSStepLoader } from '../core/CSStepLoader';
export { CSModuleDetector } from '../core/CSModuleDetector';

// Element Factory for dynamic element creation
export { CSElementFactory } from '../element/CSWebElement';
