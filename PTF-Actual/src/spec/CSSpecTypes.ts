/**
 * CS Playwright Test Framework - Spec Format Types
 * Type definitions for describe/it test format
 */

import { CSBasePage } from '../core/CSBasePage';
import { CSWebElement } from '../element/CSWebElement';
import { CSScenarioContext } from '../bdd/CSScenarioContext';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

/**
 * Data source configuration for data-driven tests
 */
export interface SpecDataSource {
    /** Data source type - auto-detected from source extension if not provided */
    type?: 'excel' | 'csv' | 'json' | 'xml' | 'database' | 'api' | 'inline';
    /** File path, connection name, or API endpoint (not required for inline) */
    source?: string;
    /** Inline data array for data-driven tests */
    data?: Record<string, any>[];
    /** Excel sheet name */
    sheet?: string;
    /** CSV delimiter */
    delimiter?: string;
    /** JSON path for nested data */
    path?: string;
    /** XML xpath */
    xpath?: string;
    /** Filter expression (e.g., "status=active;priority>3") */
    filter?: string;
    /** SQL query or named query for database */
    query?: string;
    /** Database connection name */
    connection?: string;
    /** API URL (for type: 'api') */
    url?: string;
    /** HTTP method (for type: 'api') - defaults to GET */
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    /** Request headers (for type: 'api') */
    headers?: Record<string, string>;
    /** Request body (for type: 'api' with POST/PUT/PATCH) */
    body?: any;
}

/**
 * Test options for individual test cases
 */
export interface SpecTestOptions {
    /** ADO and custom tags - array format preferred, string format supported for backward compatibility
     * @example tags: ['@smoke', '@login', '@TestPlanId:417', '@TestCaseId:419']
     * @example tags: '@smoke @login @TestPlanId:417 @TestCaseId:419' // legacy format
     */
    tags?: string[] | string;
    /** Data source for data-driven test */
    dataSource?: SpecDataSource;
    /** Test timeout in milliseconds */
    timeout?: number;
    /** Number of retries on failure */
    retries?: number;
    /** Skip condition - boolean or reason string */
    skip?: boolean | string;
    /** Annotations for reporting */
    annotations?: Array<{ type: string; description: string }>;
    /** Enable/disable this test. Default: true (enabled)
     * @example enabled: false // skip this test
     * @example enabled: true  // run this test (default)
     */
    enabled?: boolean;
    /** Mark test as needing fixes - won't run, shows as 'fixme' in report
     * @example fixme: true
     * @example fixme: 'Need to investigate timing issues'
     */
    fixme?: boolean | string;
    /** Mark test as expected to fail - if it passes, report shows error
     * @example expectedToFail: true
     * @example expectedToFail: 'Bug #123 - login redirect broken'
     */
    expectedToFail?: boolean | string;
    /** Mark test as slow - triples the timeout
     * @example slow: true
     * @example slow: 'Heavy computation test'
     */
    slow?: boolean | string;
    /** Control whether this test uses data from describe-level dataSource
     * - true: Use data iterations (default when test uses 'data' fixture)
     * - false: Skip data iterations, run test once (explicit opt-out)
     * - undefined: Auto-detect based on whether test function uses 'data' parameter
     * @example useData: false // Don't iterate even if describe has dataSource
     * @example useData: true  // Force iteration even if auto-detect fails
     */
    useData?: boolean;
    /** Declare dependency on other test(s) - test will be skipped if dependency failed
     * Can reference by tag (e.g., '@TC001') or test name
     * @example dependsOn: '@TC001'  // Depends on test with tag @TC001
     * @example dependsOn: 'Create user'  // Depends on test named 'Create user'
     * @example dependsOn: ['@TC001', '@TC002']  // Multiple dependencies (all must pass)
     */
    dependsOn?: string | string[];
}

/**
 * Execution mode for describe blocks
 * - 'serial': Tests run in order on SAME worker. If one fails, rest are SKIPPED.
 * - 'parallel': Tests can run on DIFFERENT workers (default behavior).
 * - 'default': Tests run in order but independently. If one fails, others still run.
 */
export type DescribeMode = 'serial' | 'parallel' | 'default';

/**
 * Configuration options for describe.configure()
 */
export interface DescribeConfigureOptions {
    /** Execution mode for tests in this describe */
    mode?: DescribeMode;
    /** Timeout for all tests in this describe (overrides parent) */
    timeout?: number;
    /** Retries for all tests in this describe (overrides parent) */
    retries?: number;
}

/**
 * Describe block options
 */
export interface SpecDescribeOptions {
    /** ADO and custom tags applied to all tests in this describe - array format preferred
     * @example tags: ['@orangehrm', '@login', '@TestPlanId:417', '@TestSuiteId:418']
     * @example tags: '@orangehrm @login @TestPlanId:417 @TestSuiteId:418' // legacy format
     */
    tags?: string[] | string;
    /** Data source shared by all tests in this describe */
    dataSource?: SpecDataSource;
    /** Timeout for all tests in this describe */
    timeout?: number;
    /** Retries for all tests in this describe */
    retries?: number;
    /** Skip all tests in this describe */
    skip?: boolean | string;
    /** Enable/disable this describe and all its tests. Default: true (enabled)
     * @example enabled: false // skip this describe and all tests
     * @example enabled: true  // run this describe (default)
     */
    enabled?: boolean;
    /** Mark describe as needing fixes - tests won't run, shows as 'fixme' in report
     * @example fixme: true
     * @example fixme: 'Waiting for API fix'
     */
    fixme?: boolean | string;
    /** Execution mode for tests in this describe
     * - 'serial': Tests run in order on same worker. If one fails, rest are skipped.
     * - 'parallel': Tests can run on different workers (default).
     * - 'default': Tests run in order but independently.
     * @example mode: 'serial'
     */
    mode?: DescribeMode;
}

/**
 * Parsed ADO tags from tag string
 */
export interface ParsedADOTags {
    testPlanId?: number;
    testSuiteId?: number;
    testCaseIds?: number[];
    customTags: string[];
}

/**
 * Data row from any data source
 */
export interface SpecDataRow {
    [key: string]: any;
}

/**
 * Data source metadata for reporting
 */
export interface SpecDataSourceInfo {
    type: string;
    file?: string;
    sheet?: string;
    filter?: string;
    query?: string;
    connection?: string;
    delimiter?: string;
}

/**
 * Data iteration info
 */
export interface SpecIterationInfo {
    /** Current iteration (1-based) */
    current: number;
    /** Total iterations */
    total: number;
    /** Current row data */
    data: SpecDataRow;
    /** Zero-based index of current iteration */
    index: number;
    /** Whether this is the first iteration */
    isFirst: boolean;
    /** Whether this is the last iteration */
    isLast: boolean;
    /** Columns that were actually accessed during test execution */
    usedColumns?: string[];
    /** Data source metadata for reporting */
    source?: SpecDataSourceInfo;
}

/**
 * Step/Action result within a test
 */
export interface SpecStepResult {
    /** Step name/description */
    name: string;
    /** Step status */
    status: 'passed' | 'failed' | 'skipped';
    /** Duration in milliseconds */
    duration: number;
    /** Start time */
    startTime: Date;
    /** End time */
    endTime: Date;
    /** Error message if failed */
    error?: string;
    /** Screenshot path */
    screenshot?: string;
    /** Actions performed within this step */
    actions?: SpecActionLog[];
    /** Console logs captured */
    logs?: string[];
    /** Diagnostics info */
    diagnostics?: any;
    /** Nested sub-steps for hierarchical display */
    children?: SpecStepResult[];
    /** Nesting depth level (0 = root step) */
    depth?: number;
    /** Whether this step is from a hook (beforeAll, beforeEach, etc.) */
    isHook?: boolean;
    /** Hook type if this is a hook step */
    hookType?: 'beforeAll' | 'afterAll' | 'beforeEach' | 'afterEach';
}

/**
 * Action log within a step
 */
export interface SpecActionLog {
    /** Action name (e.g., "Click on Login button") */
    name: string;
    /** Action status */
    status: 'passed' | 'failed' | 'skipped';
    /** Duration in milliseconds */
    duration: number;
    /** Timestamp */
    timestamp: Date;
    /** Element description */
    element?: string;
    /** Screenshot path */
    screenshot?: string;
}

/**
 * Test result status
 * - 'passed': Test passed normally
 * - 'failed': Test failed
 * - 'skipped': Test was skipped (skip, disabled, or serial dependency)
 * - 'fixme': Test marked as needing fixes
 * - 'expected-failure': Test was expected to fail and did fail
 * - 'unexpected-pass': Test was expected to fail but passed (error condition)
 */
export type SpecTestStatus = 'passed' | 'failed' | 'skipped' | 'fixme' | 'expected-failure' | 'unexpected-pass';

/**
 * Test result for a single test
 */
export interface SpecTestResult {
    /** Test name */
    name: string;
    /** Describe block name */
    describeName: string;
    /** Test status */
    status: SpecTestStatus;
    /** Duration in milliseconds */
    duration: number;
    /** Start time */
    startTime: Date;
    /** End time */
    endTime: Date;
    /** Error message if failed */
    error?: string;
    /** Stack trace if failed */
    stack?: string;
    /** Steps/assertions tracked during test execution */
    steps: SpecStepResult[];
    /** Screenshots paths */
    screenshots: string[];
    /** Video path */
    video?: string;
    /** Trace path */
    trace?: string;
    /** HAR file path */
    har?: string;
    /** Tags applied */
    tags: string[];
    /** Iteration info for data-driven tests */
    iteration?: SpecIterationInfo;
    /** Retry attempt number */
    retryAttempt?: number;
    /** Worker ID (for parallel execution) */
    workerId?: string;
    /** Reason for skip/fixme/expected-failure */
    skipReason?: string;
    /** Attachments added via test.info().attach() */
    attachments?: SpecAttachment[];
    /** Custom annotations added via test.info().annotations */
    customAnnotations?: Array<{ type: string; description: string }>;
    /** beforeAll hook steps (for first test in describe) */
    beforeAllSteps?: SpecStepResult[];
    /** afterAll hook steps (for last test in describe) */
    afterAllSteps?: SpecStepResult[];
    /** beforeEach hook steps */
    beforeEachSteps?: SpecStepResult[];
    /** afterEach hook steps */
    afterEachSteps?: SpecStepResult[];
}

/**
 * Describe block result
 */
export interface SpecDescribeResult {
    /** Describe block name */
    name: string;
    /** Test results */
    tests: SpecTestResult[];
    /** Nested describe results */
    describes: SpecDescribeResult[];
    /** Duration in milliseconds */
    duration: number;
    /** Tags applied */
    tags: string[];
}

/**
 * Suite result for reporting
 */
export interface SpecSuiteResult {
    /** Suite name (project name) */
    name: string;
    /** Environment */
    environment: string;
    /** Total tests */
    totalTests: number;
    /** Passed tests */
    passedTests: number;
    /** Failed tests */
    failedTests: number;
    /** Skipped tests */
    skippedTests: number;
    /** Total duration */
    duration: number;
    /** Start time */
    startTime: Date;
    /** End time */
    endTime: Date;
    /** Describe results */
    describes: SpecDescribeResult[];
}

/**
 * Step tracker for tracking test steps/actions
 */
export interface SpecStepTracker {
    /** Start a new step */
    step(name: string): Promise<void>;
    /** End current step with success */
    endStep(): void;
    /** End current step with failure */
    failStep(error: string): void;
    /** Log an action within current step */
    action(name: string, element?: string): void;
    /** Add screenshot to current step */
    screenshot(path: string): void;
    /** Get all tracked steps */
    getSteps(): SpecStepResult[];
    /** Clear all steps */
    clear(): void;
}

/**
 * Fixtures available in tests
 */
export interface SpecFixtures {
    /** Configuration manager */
    config: CSConfigurationManager;
    /** Scenario context for variable storage */
    ctx: CSScenarioContext;
    /** Current data row (for data-driven tests) */
    data: SpecDataRow;
    /** Current iteration info */
    iteration: SpecIterationInfo | null;
    /** Reporter for logging */
    reporter: any;
    /** Step tracker for tracking test steps */
    stepTracker: SpecStepTracker;
    /** API client */
    api: any;
    /** Database context */
    db: any;
    /** ADO integration */
    ado: any;
    /** CSExpect instance */
    expect: any;
    /** CSAssert instance */
    assert: any;
    /** Browser manager (for advanced scenarios) */
    browserManager: any;
    /** Playwright page object */
    page: any;
    /** Cross-domain navigation handler */
    crossDomainHandler: any;
    /** Navigate helper function */
    navigate: (url: string) => Promise<void>;
    /** Dynamically injected page objects */
    [key: string]: any;
}

/**
 * Test function signature
 */
export type SpecTestFunction = (fixtures: SpecFixtures) => Promise<void>;

/**
 * Hook function signature
 */
export type SpecHookFunction = (fixtures: SpecFixtures) => Promise<void>;

/**
 * Registered test
 */
export interface RegisteredTest {
    name: string;
    fn: SpecTestFunction;
    options: SpecTestOptions;
    describePath: string[];
}

/**
 * Registered describe block
 */
export interface RegisteredDescribe {
    name: string;
    options: SpecDescribeOptions;
    tests: RegisteredTest[];
    describes: RegisteredDescribe[];
    beforeAll: SpecHookFunction[];
    afterAll: SpecHookFunction[];
    beforeEach: SpecHookFunction[];
    afterEach: SpecHookFunction[];
    parent?: RegisteredDescribe;
}

/**
 * Spec file registration
 */
export interface SpecFileRegistration {
    filePath: string;
    describes: RegisteredDescribe[];
}

/**
 * Runner options
 */
export interface SpecRunnerOptions {
    /** Project name */
    project: string;
    /** Environment */
    env?: string;
    /** Spec file patterns */
    specs: string | string[];
    /** Tags filter */
    tags?: string;
    /** Grep pattern for test name filtering */
    grep?: string;
    /** Specific test name to run */
    test?: string;
    /** Parallel execution */
    parallel?: boolean;
    /** Number of workers */
    workers?: number;
    /** Global retries */
    retries?: number;
    /** Global timeout */
    timeout?: number;
    /** Headed mode */
    headed?: boolean;
    /** Debug mode */
    debug?: boolean;
    /** Report types */
    report?: string[];
}

/**
 * Attachment for test reports
 */
export interface SpecAttachment {
    /** Attachment name */
    name: string;
    /** File path (for file attachments) */
    path?: string;
    /** Content body (for inline content) */
    body?: string | Buffer;
    /** Content type */
    contentType?: string;
}

/**
 * Test info available during test execution via test.info()
 */
export interface SpecTestInfo {
    /** Test title */
    title: string;
    /** Full title path including describe blocks */
    titlePath: string[];
    /** Spec file path */
    file: string;
    /** Line number in file */
    line?: number;
    /** Column number */
    column?: number;
    /** Current retry attempt (0-based) */
    retry: number;
    /** Worker index in parallel mode */
    parallelIndex: number;
    /** Project name */
    project: string;
    /** Current timeout in ms */
    timeout: number;
    /** Test annotations */
    annotations: Array<{ type: string; description: string }>;
    /** Test attachments */
    attachments: SpecAttachment[];
    /** Current test status */
    status: SpecTestStatus;
    /** Error if test failed */
    error?: Error;
    /** Test duration so far */
    duration: number;
    /** Output directory for artifacts */
    outputDir: string;
    /** Snapshot directory */
    snapshotDir: string;

    /** Attach a file or data to the test report */
    attach(name: string, options: { path?: string; body?: string | Buffer; contentType?: string }): Promise<void>;
    /** Skip the test (can be called during test execution) */
    skip(condition?: boolean, reason?: string): void;
    /** Mark test as fixme */
    fixme(condition?: boolean, reason?: string): void;
    /** Mark test as expected to fail */
    fail(condition?: boolean, reason?: string): void;
    /** Mark test as slow (3x timeout) */
    slow(condition?: boolean, reason?: string): void;
    /** Set custom timeout for this test */
    setTimeout(timeout: number): void;
}

/**
 * Named hook function signature (with title)
 */
export type SpecNamedHookFunction = (fixtures: SpecFixtures, testInfo?: SpecTestInfo) => Promise<void>;

/**
 * Serial batch work item - keeps tests together on one worker
 */
export interface SpecSerialBatch {
    /** Batch ID */
    id: string;
    /** Describe block name */
    describeName: string;
    /** Spec file path */
    specFilePath: string;
    /** Tests in this batch (must run sequentially) */
    tests: Array<{
        test: RegisteredTest;
        describe: RegisteredDescribe;
        parentDescribes: RegisteredDescribe[];
        iterationNumber?: number;
        totalIterations?: number;
        dataRow?: SpecDataRow;
    }>;
    /** Runner options */
    options: SpecRunnerOptions;
}

/**
 * Runtime test state for annotations called during test execution
 */
export interface SpecRuntimeTestState {
    /** Whether test should be skipped */
    shouldSkip: boolean;
    /** Skip reason */
    skipReason?: string;
    /** Whether test is marked as fixme */
    isFixme: boolean;
    /** Fixme reason */
    fixmeReason?: string;
    /** Whether test is expected to fail */
    expectedToFail: boolean;
    /** Expected failure reason */
    expectedFailReason?: string;
    /** Whether test is slow (3x timeout) */
    isSlow: boolean;
    /** Slow reason */
    slowReason?: string;
    /** Custom timeout (overrides default) */
    customTimeout?: number;
    /** Attachments */
    attachments: SpecAttachment[];
    /** Custom annotations */
    annotations: Array<{ type: string; description: string }>;
}

/**
 * Workflow step type
 * - 'step': Regular workflow step - skipped if previous step failed
 * - 'cleanup': Cleanup step - always runs regardless of previous failures
 */
export type WorkflowStepType = 'step' | 'cleanup';

/**
 * Workflow step definition
 */
export interface WorkflowStep {
    /** Step name */
    name: string;
    /** Step function */
    fn: SpecTestFunction;
    /** Step type */
    type: WorkflowStepType;
    /** Step options (tags, timeout, etc.) */
    options?: SpecTestOptions;
}

/**
 * Registered workflow (chain of dependent tests)
 */
export interface RegisteredWorkflow {
    /** Workflow name */
    name: string;
    /** Workflow options (tags, etc.) */
    options: SpecDescribeOptions;
    /** Ordered steps in the workflow */
    steps: WorkflowStep[];
    /** Parent describe block */
    parent?: RegisteredDescribe;
}

/**
 * Dependency tracking result
 */
export interface DependencyResult {
    /** Test identifier (name or tag) */
    testId: string;
    /** Whether the dependency passed */
    passed: boolean;
    /** Test name that matched */
    matchedTestName?: string;
    /** Failure reason if not passed */
    failureReason?: string;
}

/**
 * Test dependency tracker for managing test dependencies
 */
export interface TestDependencyTracker {
    /** Record a test result */
    recordResult(testName: string, tags: string[], status: SpecTestStatus, error?: string): void;
    /** Check if all dependencies for a test are satisfied */
    checkDependencies(dependsOn: string | string[]): DependencyResult[];
    /** Check if a specific dependency passed */
    hasPassed(testId: string): boolean;
    /** Get failure reason for a dependency */
    getFailureReason(testId: string): string | undefined;
    /** Clear all recorded results */
    clear(): void;
}
