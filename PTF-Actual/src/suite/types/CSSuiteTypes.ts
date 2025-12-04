/**
 * CS Suite Types - Type definitions for multi-project test execution
 * @module suite/types
 */

// ============================================================================
// Suite Configuration Types
// ============================================================================

/**
 * Project type enumeration
 */
export type ProjectType = 'api' | 'ui' | 'hybrid';

/**
 * Project execution status
 */
export type ProjectStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'error';

/**
 * Scenario execution status
 */
export type ScenarioStatus = 'passed' | 'failed' | 'skipped' | 'pending';

/**
 * Suite execution mode
 */
export type SuiteMode = 'all' | 'api-only' | 'ui-only';

/**
 * Individual project configuration in suite
 */
export interface SuiteProjectConfig {
    /** Display name for the project */
    name: string;

    /** Project type (api, ui, hybrid) */
    type: ProjectType;

    /** Project identifier (matches config folder name) */
    project: string;

    /** Feature file path(s) - can be single file or glob pattern */
    features: string | string[];

    /** Optional tags to filter scenarios */
    tags?: string;

    /** Whether this project is enabled */
    enabled: boolean;

    /** Optional environment override for this project */
    environment?: string;

    /** Optional timeout override for this project (ms) */
    timeout?: number;

    /** Optional browser override for UI tests */
    browser?: 'chromium' | 'firefox' | 'webkit';

    /** Optional headless override */
    headless?: boolean;

    /** Optional parallel workers override for this project */
    parallel?: number;

    /** Optional retry count override */
    retry?: number;
}

/**
 * Suite defaults configuration
 */
export interface SuiteDefaults {
    /** Default environment */
    environment: string;

    /** Default headless mode */
    headless: boolean;

    /** Default timeout in milliseconds */
    timeout: number;

    /** Default browser for UI tests */
    browser?: 'chromium' | 'firefox' | 'webkit';

    /** Default parallel workers */
    parallel?: number;

    /** Default retry count */
    retry?: number;
}

/**
 * Suite execution configuration
 */
export interface SuiteExecutionConfig {
    /** Execution mode (sequential is the only supported mode) */
    mode: 'sequential';

    /** Stop execution on first project failure */
    stopOnFailure: boolean;

    /** Delay between projects in milliseconds */
    delayBetweenProjects: number;
}

/**
 * Suite reporting configuration
 */
export interface SuiteReportingConfig {
    /** Generate consolidated report */
    consolidated: boolean;

    /** Auto-open report in browser after execution */
    autoOpen: boolean;

    /** Report formats to generate */
    formats: ('html' | 'json' | 'xlsx')[];
}

/**
 * Complete suite configuration (from YAML)
 */
export interface SuiteConfig {
    /** Config file version */
    version: string;

    /** Suite name */
    name: string;

    /** Suite description */
    description?: string;

    /** Default settings */
    defaults: SuiteDefaults;

    /** Execution settings */
    execution: SuiteExecutionConfig;

    /** Reporting settings */
    reporting: SuiteReportingConfig;

    /** Projects to execute */
    projects: SuiteProjectConfig[];
}

// ============================================================================
// Suite Execution Result Types
// ============================================================================

/**
 * Individual scenario result
 */
export interface ScenarioResult {
    /** Scenario name */
    name: string;

    /** Feature file name */
    feature: string;

    /** Execution status */
    status: ScenarioStatus;

    /** Duration in milliseconds */
    duration: number;

    /** Tags on this scenario */
    tags: string[];

    /** Error message if failed */
    error?: string;

    /** Screenshot paths */
    screenshots: string[];

    /** Video path */
    videos: string[];

    /** Trace file path */
    trace?: string;

    /** Steps in this scenario */
    steps?: StepResult[];
}

/**
 * Individual step result
 */
export interface StepResult {
    /** Step keyword (Given, When, Then, And, But) */
    keyword: string;

    /** Step text */
    text: string;

    /** Execution status */
    status: ScenarioStatus;

    /** Duration in milliseconds */
    duration: number;

    /** Error message if failed */
    error?: string;
}

/**
 * Project execution result
 */
export interface ProjectResult {
    /** Project display name */
    name: string;

    /** Project identifier */
    project: string;

    /** Project type */
    type: ProjectType;

    /** Overall project status */
    status: ProjectStatus;

    /** Total duration in milliseconds */
    duration: number;

    /** Start timestamp */
    startTime: string;

    /** End timestamp */
    endTime: string;

    /** Feature file(s) executed */
    features: string[];

    /** Scenarios in this project */
    scenarios: ScenarioResult[];

    /** Total scenario count */
    totalScenarios: number;

    /** Passed scenario count */
    passedScenarios: number;

    /** Failed scenario count */
    failedScenarios: number;

    /** Skipped scenario count */
    skippedScenarios: number;

    /** Path to project report folder */
    reportPath: string;

    /** Path to project's index.html report */
    htmlReportPath?: string;

    /** Path to project's report-data.json */
    jsonReportPath?: string;

    /** Exit code from project execution */
    exitCode: number;

    /** Error message if execution failed */
    error?: string;

    /** ADO test run ID if published */
    adoTestRunId?: number;

    /** Environment used */
    environment: string;
}

/**
 * Complete suite execution result
 */
export interface SuiteResult {
    /** Suite name */
    suiteName: string;

    /** Suite execution timestamp */
    timestamp: string;

    /** Overall suite status */
    status: 'passed' | 'failed' | 'partial';

    /** Total duration in milliseconds */
    totalDuration: number;

    /** Start timestamp */
    startTime: string;

    /** End timestamp */
    endTime: string;

    /** Projects executed */
    projects: ProjectResult[];

    /** Total project count */
    totalProjects: number;

    /** Passed project count */
    passedProjects: number;

    /** Failed project count */
    failedProjects: number;

    /** Skipped project count */
    skippedProjects: number;

    /** Total scenarios across all projects */
    totalScenarios: number;

    /** Passed scenarios across all projects */
    passedScenarios: number;

    /** Failed scenarios across all projects */
    failedScenarios: number;

    /** Skipped scenarios across all projects */
    skippedScenarios: number;

    /** Success rate percentage */
    successRate: number;

    /** Path to suite report directory */
    reportPath: string;

    /** Path to consolidated HTML report */
    consolidatedReportPath?: string;

    /** Execution environment info */
    environment: EnvironmentInfo;
}

/**
 * Environment information for reporting
 */
export interface EnvironmentInfo {
    /** Node.js version */
    nodeVersion: string;

    /** Operating system */
    os: string;

    /** OS version */
    osVersion: string;

    /** Framework version */
    frameworkVersion: string;

    /** Playwright version */
    playwrightVersion: string;

    /** Machine hostname */
    hostname: string;

    /** Username */
    username: string;
}

// ============================================================================
// Consolidated Report Types
// ============================================================================

/**
 * Aggregated data for consolidated report
 */
export interface ConsolidatedReportData {
    /** Report generation timestamp */
    generatedAt: string;

    /** Suite name */
    suiteName: string;

    /** Suite status */
    status: 'passed' | 'failed' | 'partial';

    /** Total duration formatted string */
    totalDurationFormatted: string;

    /** Total duration in milliseconds */
    totalDuration: number;

    /** Total projects */
    totalProjects: number;

    /** Passed projects */
    passedProjects: number;

    /** Failed projects */
    failedProjects: number;

    /** Total scenarios */
    totalScenarios: number;

    /** Passed scenarios */
    passedScenarios: number;

    /** Failed scenarios */
    failedScenarios: number;

    /** Skipped scenarios */
    skippedScenarios: number;

    /** Success rate */
    successRate: string;

    /** Projects data */
    projects: ProjectReportData[];

    /** Environment info */
    environment: EnvironmentInfo;
}

/**
 * Project data for consolidated report
 */
export interface ProjectReportData {
    /** Project name */
    name: string;

    /** Project type */
    type: ProjectType;

    /** Project status */
    status: ProjectStatus;

    /** Duration in seconds */
    duration: number;

    /** Duration formatted string */
    durationFormatted: string;

    /** Total scenarios */
    scenarioCount: number;

    /** Passed scenarios */
    passed: number;

    /** Failed scenarios */
    failed: number;

    /** Skipped scenarios */
    skipped: number;

    /** Success rate for this project */
    successRate: string;

    /** Relative path to project report */
    reportPath: string;

    /** Scenarios data */
    scenarios: ScenarioReportData[];
}

/**
 * Scenario data for consolidated report
 */
export interface ScenarioReportData {
    /** Scenario name */
    name: string;

    /** Feature name */
    feature: string;

    /** Status */
    status: ScenarioStatus;

    /** Duration in seconds */
    duration: number;

    /** Duration formatted string */
    durationFormatted: string;

    /** Tags */
    tags: string[];

    /** Error message if failed */
    error?: string;

    /** Screenshot paths (relative to project folder) */
    screenshots: string[];

    /** Video paths (relative to project folder) */
    videos: string[];
}

// ============================================================================
// CLI Options Types
// ============================================================================

/**
 * Suite CLI options
 */
export interface SuiteCLIOptions {
    /** Suite mode flag */
    suite: string;

    /** Custom suite config file path */
    suiteConfig?: string;

    /** Suite mode filter (all, api-only, ui-only) */
    suiteMode?: SuiteMode;

    /** Stop on first failure */
    suiteStopOnFailure?: boolean;

    /** Tags filter (applies to all projects) */
    tags?: string;

    /** Environment override (applies to all projects) */
    environment?: string;

    /** Headless mode */
    headless?: boolean;

    /** Parallel workers per project */
    parallel?: number | boolean;

    /** Workers count */
    workers?: number;
}

// ============================================================================
// Event Types for Progress Tracking
// ============================================================================

/**
 * Suite execution event types
 */
export type SuiteEventType =
    | 'suite:start'
    | 'suite:complete'
    | 'project:start'
    | 'project:complete'
    | 'scenario:start'
    | 'scenario:complete'
    | 'report:generating'
    | 'report:complete';

/**
 * Suite execution event
 */
export interface SuiteEvent {
    /** Event type */
    type: SuiteEventType;

    /** Event timestamp */
    timestamp: string;

    /** Event data */
    data: any;
}

/**
 * Suite progress callback
 */
export type SuiteProgressCallback = (event: SuiteEvent) => void;
