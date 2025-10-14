/**
 * CS Playwright Test Framework - Reporting Entry Point
 *
 * Lightweight entry point for reporting and test results
 *
 * @example
 * import { CSReporter, CSHTMLReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';
 */

// Core (minimal)
export { CSConfigurationManager } from '../core/CSConfigurationManager';

// Reporting
export { CSReporter } from '../reporter/CSReporter';
export { CSHTMLReporter } from '../reporter/CSHTMLReporter';
export { CSEnterpriseReporter } from '../reporter/CSEnterpriseReporter';
export { CSTestResultsManager } from '../reporter/CSTestResultsManager';

// Azure DevOps Integration
export { CSADOClient } from '../ado/CSADOClient';
export { CSADOIntegration } from '../ado/CSADOIntegration';
export { CSADOConfiguration } from '../ado/CSADOConfiguration';
export { CSADOTagExtractor } from '../ado/CSADOTagExtractor';

// Dashboard
export { CSLiveDashboard } from '../dashboard/CSLiveDashboard';

// Pipeline Orchestration
export { CSPipelineOrchestrator } from '../pipeline/CSPipelineOrchestrator';

// Parallel Execution Support
export { CSParallelMediaHandler } from '../parallel/CSParallelMediaHandler';
export { CSTerminalLogCapture } from '../parallel/CSTerminalLogCapture';

// Media & Evidence
export { CSVideoRecorder } from '../media/CSVideoRecorder';
export { CSScreenshotManager } from '../media/CSScreenshotManager';
export { CSEvidenceCollector } from '../evidence/CSEvidenceCollector';
