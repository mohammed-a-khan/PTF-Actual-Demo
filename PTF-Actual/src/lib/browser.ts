/**
 * CS Playwright Test Framework - Browser/UI Entry Point
 *
 * Lightweight entry point for browser and UI testing
 *
 * @example
 * import { CSBrowserManager, CSBasePage } from '@mdakhan.mak/cs-playwright-test-framework/browser';
 */

// Core Framework
export { CSConfigurationManager } from '../core/CSConfigurationManager';
export { CSBasePage } from '../core/CSBasePage';
export { CSPageFactory, CSPage, CSGetElement, CSGetElements, CSElement, CSElements } from '../core/CSPageFactory';

// Elements & Browser
export { CSWebElement } from '../element/CSWebElement';
export { CSElementResolver } from '../element/CSElementResolver';
export { CSBrowserPool } from '../browser/CSBrowserPool';
export { CSBrowserManager } from '../browser/CSBrowserManager';

// Reporting
export { CSReporter } from '../reporter/CSReporter';

// Assertions
export { CSAssert } from '../assertions/CSAssert';
export { CSExpect } from '../assertions/CSExpect';

// Utilities
export { CSValueResolver } from '../utils/CSValueResolver';
export { CSEncryptionUtil } from '../utils/CSEncryptionUtil';

// Diagnostics
export { CSPageDiagnostics } from '../diagnostics/CSPageDiagnostics';
export type { PageDiagnosticData, DiagnosticConsoleLog, DiagnosticError, DiagnosticRequest, DiagnosticOptions } from '../diagnostics/CSPageDiagnostics';

// Visual Testing
export { CSVisualTesting } from '../visual/CSVisualTesting';

// Network
export { CSNetworkInterceptor } from '../network/CSNetworkInterceptor';

// Mobile Testing
export { CSMobileTesting } from '../mobile/CSMobileTesting';

// Navigation
export { CSCrossDomainNavigationHandler } from '../navigation/CSCrossDomainNavigationHandler';

// Media & Evidence
export { CSVideoRecorder } from '../media/CSVideoRecorder';
export { CSScreenshotManager } from '../media/CSScreenshotManager';
export { CSEvidenceCollector } from '../evidence/CSEvidenceCollector';

// Performance & Monitoring
export { CSPerformanceMonitor } from '../monitoring/CSPerformanceMonitor';
