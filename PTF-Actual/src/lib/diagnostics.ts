/**
 * CS Playwright Test Framework - Diagnostics Entry Point
 *
 * Only exports diagnostics modules
 *
 * @example
 * import { CSDiagnostics, CSPerformanceMonitor } from '@mdakhan.mak/cs-playwright-test-framework/diagnostics';
 */

// Diagnostics Core
export { CSPageDiagnostics } from '../diagnostics/CSPageDiagnostics';
export { PageDiagnosticData, DiagnosticConsoleLog, DiagnosticError, DiagnosticRequest, DiagnosticOptions } from '../diagnostics/CSPageDiagnostics';
