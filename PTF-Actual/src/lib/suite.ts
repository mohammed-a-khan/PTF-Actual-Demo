/**
 * Suite Module Library Export
 * Provides multi-project test execution capabilities
 * @module lib/suite
 */

export {
    // Types
    ProjectType,
    ProjectStatus,
    ScenarioStatus,
    SuiteMode,
    SuiteProjectConfig,
    SuiteDefaults,
    SuiteExecutionConfig,
    SuiteReportingConfig,
    SuiteConfig,
    ScenarioResult,
    StepResult,
    ProjectResult,
    SuiteResult,
    EnvironmentInfo,
    ConsolidatedReportData,
    ProjectReportData,
    ScenarioReportData,
    SuiteCLIOptions,
    SuiteEventType,
    SuiteEvent,
    SuiteProgressCallback,

    // Classes
    CSSuiteConfigLoader,
    CSSuiteExecutor,
    CSSuiteOrchestrator,
    CSConsolidatedReportGenerator
} from '../suite';
