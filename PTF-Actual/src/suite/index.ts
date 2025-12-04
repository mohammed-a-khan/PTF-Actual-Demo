/**
 * CS Suite Module - Multi-project test execution
 * @module suite
 */

// Type exports
export * from './types/CSSuiteTypes';

// Core exports
export { CSSuiteConfigLoader } from './CSSuiteConfigLoader';
export { CSSuiteExecutor } from './CSSuiteExecutor';
export { CSSuiteOrchestrator } from './CSSuiteOrchestrator';
export { CSConsolidatedReportGenerator } from './CSConsolidatedReportGenerator';

// Default export
export { CSSuiteOrchestrator as default } from './CSSuiteOrchestrator';
