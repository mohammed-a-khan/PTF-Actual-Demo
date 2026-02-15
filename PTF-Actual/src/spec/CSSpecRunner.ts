/**
 * CS Playwright Test Framework - Spec Format Runner
 * Main orchestrator for describe/it test execution
 */

import * as fs from 'fs';
import * as path from 'path';
import * as glob from 'glob';
import {
    SpecRunnerOptions,
    SpecTestResult,
    SpecDescribeResult,
    SpecSuiteResult,
    SpecDataRow,
    SpecFixtures,
    SpecStepResult,
    RegisteredDescribe,
    RegisteredTest,
    SpecTestStatus,
    SpecRuntimeTestState
} from './CSSpecTypes';
import { CSSpecADOResolver } from './CSSpecADOResolver';
import { CSSpecDataIterator } from './CSSpecDataIterator';
import { CSSpecPageInjector } from './CSSpecPageInjector';
import { CSSpecStepTrackerImpl, createStepTracker, setCurrentStepTracker, hookElementActions, hookReporterActions } from './CSSpecStepTracker';
import { createTestInfo, createRuntimeState } from './CSSpecTestInfo';
import { setCurrentTestState, setCurrentTestInfo, getCurrentTestState } from './CSSpecDescribe';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSReporter } from '../reporter/CSReporter';
import { CSTestResultsManager } from '../reporter/CSTestResultsManager';

// Lazy-loaded dependencies
let CSBrowserManager: any = null;
let CSScenarioContext: any = null;
let CSExpect: any = null;
let CSAssert: any = null;
let CSADOIntegration: any = null;
let CSHtmlReportGenerator: any = null;
let ParallelOrchestrator: any = null;
let CSCrossDomainNavigationHandler: any = null;

/**
 * Dependency tracker for managing test dependencies
 */
class DependencyTracker {
    private results: Map<string, { status: SpecTestStatus; error?: string }> = new Map();
    private tagToTestMap: Map<string, string> = new Map();

    /**
     * Record a test result for dependency tracking
     */
    recordResult(testName: string, tags: string[], status: SpecTestStatus, error?: string): void {
        // Store by test name
        this.results.set(testName, { status, error });

        // Store by each tag
        for (const tag of tags) {
            this.tagToTestMap.set(tag, testName);
            this.results.set(tag, { status, error });
        }

        CSReporter.debug(`[DependencyTracker] Recorded: ${testName} = ${status}`);
    }

    /**
     * Check if all dependencies passed
     */
    checkDependencies(dependsOn: string | string[]): { passed: boolean; failedDeps: string[]; reasons: string[] } {
        const deps = Array.isArray(dependsOn) ? dependsOn : [dependsOn];
        const failedDeps: string[] = [];
        const reasons: string[] = [];

        for (const dep of deps) {
            const result = this.results.get(dep);
            if (!result) {
                // Dependency not found - could be not yet executed
                failedDeps.push(dep);
                reasons.push(`Dependency "${dep}" not found or not yet executed`);
            } else if (result.status !== 'passed') {
                failedDeps.push(dep);
                reasons.push(`Dependency "${dep}" ${result.status}${result.error ? `: ${result.error}` : ''}`);
            }
        }

        return {
            passed: failedDeps.length === 0,
            failedDeps,
            reasons
        };
    }

    /**
     * Check if a specific dependency passed
     */
    hasPassed(testId: string): boolean {
        const result = this.results.get(testId);
        return result?.status === 'passed';
    }

    /**
     * Clear all recorded results
     */
    clear(): void {
        this.results.clear();
        this.tagToTestMap.clear();
    }
}

/**
 * Main runner for spec format tests
 */
export class CSSpecRunner {
    private static instance: CSSpecRunner;
    private config: CSConfigurationManager;
    private adoResolver: CSSpecADOResolver;
    private dataIterator: CSSpecDataIterator;
    private pageInjector: CSSpecPageInjector;
    private resultsManager: CSTestResultsManager;
    private browserManager: any = null;
    private adoIntegration: any = null;
    private suiteResult: SpecSuiteResult | null = null;
    private currentStepTracker: CSSpecStepTrackerImpl | null = null;
    private elementHooksInstalled: boolean = false;
    private testCountForReuse: number = 0;
    private hasAnyFailures: boolean = false;
    private dependencyTracker: DependencyTracker = new DependencyTracker();

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.adoResolver = CSSpecADOResolver.getInstance();
        this.dataIterator = CSSpecDataIterator.getInstance();
        this.pageInjector = CSSpecPageInjector.getInstance();
        this.resultsManager = CSTestResultsManager.getInstance();
    }

    public static getInstance(): CSSpecRunner {
        if (!CSSpecRunner.instance) {
            CSSpecRunner.instance = new CSSpecRunner();
        }
        return CSSpecRunner.instance;
    }

    /**
     * Main entry point for running spec tests
     */
    public async run(options: SpecRunnerOptions): Promise<SpecSuiteResult> {
        const startTime = Date.now();

        try {
            CSReporter.info('╔════════════════════════════════════════════════════════════╗');
            CSReporter.info('║          CS Playwright Framework - Spec Runner             ║');
            CSReporter.info('╚════════════════════════════════════════════════════════════╝');

            // 1. Initialize configuration
            await this.initializeConfiguration(options);

            // 1.0. Clear dependency tracker for fresh run
            this.dependencyTracker.clear();

            // 1.1. Initialize test results directory ONCE at start (like BDD runner)
            const project = options.project || this.config.get('PROJECT', 'CS-Framework');
            this.resultsManager.initializeTestRun(project);
            CSReporter.info(`[SpecRunner] Test results directory: ${this.resultsManager.getDirectories().base}`);

            // 1.5. Install element action hooks for step tracking (once)
            if (!this.elementHooksInstalled) {
                hookElementActions();
                hookReporterActions();  // Also hook CSReporter.pass/fail/info to capture in step tracker
                this.elementHooksInstalled = true;
            }

            // 2. Discover and load spec files
            const specFiles = await this.discoverSpecFiles(options);
            if (specFiles.length === 0) {
                throw new Error(`No spec files found matching: ${options.specs}`);
            }
            CSReporter.info(`[SpecRunner] Found ${specFiles.length} spec file(s)`);

            // 3. Scan for page objects
            await this.pageInjector.scanPages();

            // 4. Collect all tests first (needed for ADO integration)
            const collectedTests = await this.collectAllTests(specFiles, options);

            // 5. Initialize ADO if enabled (with collected tests for test point mapping)
            await this.initializeADO(options, collectedTests);

            // 6. Execute tests
            let suiteResult: SpecSuiteResult;
            if (options.parallel && options.workers && options.workers > 1) {
                suiteResult = await this.runParallelWithCollectedTests(specFiles, collectedTests, options);
            } else {
                suiteResult = await this.runSequentialWithCollectedTests(specFiles, collectedTests, options);
            }

            // 7. Close browser and save final artifacts (HAR, video) BEFORE report generation
            await this.saveFinalArtifacts();

            // 8. Calculate duration BEFORE generating reports so it's included
            const duration = Date.now() - startTime;
            suiteResult.duration = duration;

            // 9. Generate reports (now HAR files will be available for collection)
            await this.generateReports(suiteResult, options);

            // 10. Complete ADO integration
            await this.completeADO(suiteResult);

            CSReporter.info('╔════════════════════════════════════════════════════════════╗');
            CSReporter.info(`║  Spec Run Complete: ${suiteResult.passedTests}/${suiteResult.totalTests} passed in ${duration}ms  `);
            CSReporter.info('╚════════════════════════════════════════════════════════════╝');

            return suiteResult;
        } catch (error: any) {
            CSReporter.error(`[SpecRunner] Fatal error: ${error.message}`);
            throw error;
        } finally {
            await this.cleanup();
        }
    }

    /**
     * Initialize configuration from options
     */
    private async initializeConfiguration(options: SpecRunnerOptions): Promise<void> {
        // Set project and environment
        if (options.project) {
            process.env.PROJECT = options.project;
        }
        if (options.env) {
            process.env.ENVIRONMENT = options.env;
        }

        // Initialize config manager
        await this.config.initialize({
            project: options.project,
            env: options.env
        });

        // Apply CLI overrides
        if (options.headed !== undefined) {
            process.env.HEADLESS = options.headed ? 'false' : 'true';
        }
        if (options.timeout) {
            process.env.DEFAULT_TIMEOUT = String(options.timeout);
        }
        if (options.retries !== undefined) {
            process.env.RETRY_COUNT = String(options.retries);
        }
        if (options.workers) {
            process.env.PARALLEL_WORKERS = String(options.workers);
        }

        CSReporter.info(`[SpecRunner] Configuration initialized for project: ${options.project}`);
    }

    /**
     * Discover spec files matching patterns
     */
    private async discoverSpecFiles(options: SpecRunnerOptions): Promise<string[]> {
        const patterns = Array.isArray(options.specs) ? options.specs : [options.specs];
        const specFiles: string[] = [];

        for (const pattern of patterns) {
            if (pattern.includes('*')) {
                // Glob pattern
                const matches = glob.sync(pattern, { cwd: process.cwd() });
                specFiles.push(...matches.map(m => path.resolve(process.cwd(), m)));
            } else if (fs.existsSync(pattern)) {
                const stat = fs.statSync(pattern);
                if (stat.isDirectory()) {
                    // Directory - find all .spec.ts files
                    const matches = glob.sync(path.join(pattern, '**/*.spec.ts'), { cwd: process.cwd() });
                    specFiles.push(...matches.map(m => path.resolve(process.cwd(), m)));
                } else {
                    // Single file
                    specFiles.push(path.resolve(process.cwd(), pattern));
                }
            }
        }

        // Filter to only .spec.ts files
        return specFiles.filter(f => f.endsWith('.spec.ts') || f.endsWith('.spec.js'));
    }

    /**
     * Collected test structure for ADO integration
     */
    private collectedTestsCache: Array<{
        test: RegisteredTest;
        describe: RegisteredDescribe;
        parentDescribes: RegisteredDescribe[];
        specFilePath: string;
    }> = [];

    /**
     * Collect all tests from spec files for ADO integration
     * This needs to happen before ADO initialization so test points can be mapped
     */
    private async collectAllTests(specFiles: string[], options: SpecRunnerOptions): Promise<Array<{
        test: RegisteredTest;
        describe: RegisteredDescribe;
        parentDescribes: RegisteredDescribe[];
        specFilePath: string;
    }>> {
        const collectedTests: Array<{
            test: RegisteredTest;
            describe: RegisteredDescribe;
            parentDescribes: RegisteredDescribe[];
            specFilePath: string;
        }> = [];

        for (const specFile of specFiles) {
            CSReporter.info(`[SpecRunner] Loading: ${path.basename(specFile)}`);
            const describes = await this.loadSpecFile(specFile);

            const collectTests = (describe: RegisteredDescribe, parents: RegisteredDescribe[] = []) => {
                for (const test of describe.tests) {
                    // Check if test matches filters (including enabled flag)
                    if (this.matchesFilters(test, describe, options, parents)) {
                        collectedTests.push({
                            test,
                            describe,
                            parentDescribes: parents,
                            specFilePath: specFile
                        });
                    }
                }
                for (const nested of describe.describes) {
                    collectTests(nested, [...parents, describe]);
                }
            };

            for (const describe of describes) {
                collectTests(describe);
            }
        }

        CSReporter.info(`[SpecRunner] Collected ${collectedTests.length} tests for execution`);
        this.collectedTestsCache = collectedTests;
        return collectedTests;
    }

    /**
     * Convert collected tests to scenario/feature format for ADO
     */
    private convertTestsToScenarios(collectedTests: Array<{
        test: RegisteredTest;
        describe: RegisteredDescribe;
        parentDescribes: RegisteredDescribe[];
        specFilePath: string;
    }>): Array<{ scenario: any; feature: any }> {
        const scenarios: Array<{ scenario: any; feature: any }> = [];

        for (const { test, describe, parentDescribes } of collectedTests) {
            // ADO Tag Priority: Test level > Describe level > Config level
            // Scenario gets ONLY test-level tags (highest priority)
            // Feature gets describe-level + parent describe tags (fallback)

            // Collect TEST-level tags only for scenario (highest priority in ADO)
            const testTags: string[] = [];
            if (test.options.tags) {
                const tags = Array.isArray(test.options.tags) ? test.options.tags : [test.options.tags];
                testTags.push(...tags);
            }

            // Collect DESCRIBE-level tags for feature (fallback in ADO)
            // Order matters: ADOTagExtractor takes FIRST match, so highest priority first
            const featureTags: string[] = [];

            // Add immediate describe tags FIRST (highest priority in describe hierarchy)
            if (describe.options.tags) {
                const tags = Array.isArray(describe.options.tags) ? describe.options.tags : [describe.options.tags];
                featureTags.push(...tags);
            }

            // Add parent describe tags in reverse order (innermost to outermost)
            // So nested describe tags are checked before outer describe tags
            for (let i = parentDescribes.length - 1; i >= 0; i--) {
                const pd = parentDescribes[i];
                if (pd.options.tags) {
                    const tags = Array.isArray(pd.options.tags) ? pd.options.tags : [pd.options.tags];
                    featureTags.push(...tags);
                }
            }

            // Create scenario object - ONLY test-level tags
            // ADOTagExtractor checks scenario.tags FIRST for plan/suite/testcase
            const scenario = {
                name: test.name,
                tags: testTags.map(t => t.startsWith('@') ? t : `@${t}`)
            };

            // Create feature object - describe-level tags as FALLBACK
            // ADOTagExtractor checks feature.tags if not found in scenario
            const feature = {
                name: describe.name,
                tags: featureTags.map((t: string) => t.startsWith('@') ? t : `@${t}`)
            };

            // Handle data-driven tests - add iteration scenarios
            const dataSource = test.options.dataSource || describe.options.dataSource;
            if (dataSource && dataSource.data && dataSource.data.length > 0) {
                for (let i = 0; i < dataSource.data.length; i++) {
                    scenarios.push({
                        scenario: {
                            ...scenario,
                            name: `${test.name} [Iteration ${i + 1}/${dataSource.data.length}]`
                        },
                        feature
                    });
                }
            } else {
                scenarios.push({ scenario, feature });
            }
        }

        return scenarios;
    }

    /**
     * Run tests sequentially with collected tests and ADO reporting
     * Handles serial mode: if a test fails in a serial describe, remaining tests are skipped
     */
    private async runSequentialWithCollectedTests(
        specFiles: string[],
        collectedTests: Array<{
            test: RegisteredTest;
            describe: RegisteredDescribe;
            parentDescribes: RegisteredDescribe[];
            specFilePath: string;
        }>,
        options: SpecRunnerOptions
    ): Promise<SpecSuiteResult> {
        const suiteResult: SpecSuiteResult = this.createEmptySuiteResult(options);

        // Track serial describe failures (key = describe name)
        const serialDescribeFailures = new Map<string, boolean>();

        // Group tests by describe while preserving order
        const describeMap = new Map<string, {
            describe: RegisteredDescribe;
            tests: Array<{ test: RegisteredTest; parentDescribes: RegisteredDescribe[] }>;
        }>();

        for (const { test, describe, parentDescribes } of collectedTests) {
            const key = describe.name;
            if (!describeMap.has(key)) {
                describeMap.set(key, { describe, tests: [] });
            }
            describeMap.get(key)!.tests.push({ test, parentDescribes });
        }

        // Execute tests in order
        for (const [describeName, { describe, tests }] of describeMap) {
            CSReporter.info(`[SpecRunner] Describe: ${describeName}`);

            // Check if this describe is in serial mode
            const isSerialMode = describe.options.mode === 'serial';
            if (isSerialMode) {
                CSReporter.debug(`[SpecRunner] Serial mode enabled for: ${describeName}`);
                // Clear context at the START of a serial describe block
                // This ensures fresh context for each serial describe, but preserved WITHIN it
                if (!CSScenarioContext) {
                    CSScenarioContext = require('../bdd/CSScenarioContext').CSScenarioContext;
                }
                CSScenarioContext.getInstance().clear();
                CSReporter.debug(`[SpecRunner] Context cleared for serial describe: ${describeName}`);
            }

            // Execute beforeAll hooks if present - with step tracking
            let beforeAllSteps: SpecStepResult[] = [];
            if (describe.beforeAll && describe.beforeAll.length > 0) {
                CSReporter.debug(`[SpecRunner] Running beforeAll hooks for: ${describeName}`);

                // Create step tracker for beforeAll hooks
                const beforeAllTracker = createStepTracker();
                beforeAllTracker.setHookType('beforeAll');
                setCurrentStepTracker(beforeAllTracker);
                // IMPORTANT: Set instance tracker so createFixtures doesn't create a new one
                this.currentStepTracker = beforeAllTracker;

                try {
                    // Ensure browser manager is initialized first
                    await this.ensureBrowserManager();

                    // Ensure browser is ready for beforeAll hooks
                    let existingPage: any = null;
                    try {
                        existingPage = this.browserManager?.getPage?.();
                    } catch (e) {
                        // Page not initialized yet - this is expected
                    }

                    if (!existingPage) {
                        CSReporter.debug(`[SpecRunner] Launching browser for beforeAll hooks: ${describeName}`);
                        // launch() creates browser, context, AND page all in one call
                        await this.browserManager?.launch?.();
                        // Verify page was created
                        try {
                            const pageAfterLaunch = this.browserManager?.getPage?.();
                            CSReporter.debug(`[SpecRunner] Page after launch: ${pageAfterLaunch ? 'created' : 'NOT CREATED'}`);
                        } catch (e: any) {
                            CSReporter.error(`[SpecRunner] Page still not available after launch: ${e.message}`);
                        }
                    } else {
                        CSReporter.debug(`[SpecRunner] Using existing browser for beforeAll hooks: ${describeName}`);
                    }

                    // Create fixtures for beforeAll hooks
                    const beforeAllFixtures = await this.createFixtures({}, null, isSerialMode);

                    // Execute each beforeAll hook with step tracking
                    for (const hook of describe.beforeAll) {
                        // Get hook title if available (named hooks)
                        const hookTitle = (hook as any).title || 'beforeAll';
                        await beforeAllTracker.step(`[beforeAll] ${hookTitle}`);
                        try {
                            await hook(beforeAllFixtures);
                            beforeAllTracker.endStep();
                        } catch (hookError: any) {
                            beforeAllTracker.failStep(hookError?.message || String(hookError));
                            throw hookError;
                        }
                    }
                    CSReporter.debug(`[SpecRunner] beforeAll hooks completed for: ${describeName}`);
                } catch (error: any) {
                    CSReporter.error(`[SpecRunner] beforeAll hook failed for ${describeName}: ${error.message}`);
                    // Mark all tests in this describe as failed due to beforeAll failure
                    serialDescribeFailures.set(describeName, true);
                } finally {
                    // Collect beforeAll steps
                    beforeAllSteps = beforeAllTracker.finalize();
                    setCurrentStepTracker(null);
                    this.currentStepTracker = null;  // Clear instance tracker
                }
            }

            // Check if describe is marked as fixme
            const isFixme = describe.options.fixme;

            for (const { test, parentDescribes } of tests) {
                // Find or create describe result
                let describeResult = suiteResult.describes.find(d => d.name === describeName);
                if (!describeResult) {
                    const describeTags = Array.isArray(describe.options.tags)
                        ? describe.options.tags
                        : (describe.options.tags ? [describe.options.tags] : []);
                    describeResult = {
                        name: describeName,
                        tests: [],
                        describes: [],
                        duration: 0,
                        tags: describeTags
                    };
                    suiteResult.describes.push(describeResult);
                }

                // Handle describe-level fixme
                if (isFixme) {
                    const fixmeReason = typeof isFixme === 'string' ? isFixme : 'Describe marked as fixme';
                    const skippedResult: SpecTestResult = {
                        name: test.name,
                        describeName: describe.name,
                        status: 'fixme',
                        duration: 0,
                        startTime: new Date(),
                        endTime: new Date(),
                        steps: [],
                        screenshots: [],
                        tags: [],
                        skipReason: fixmeReason
                    };
                    describeResult.tests.push(skippedResult);
                    suiteResult.totalTests++;
                    suiteResult.skippedTests++;
                    CSReporter.warn(`    ⚠ ${test.name} - fixme: ${fixmeReason}`);
                    continue;
                }

                // Check for serial mode failure - skip remaining tests (except cleanup steps)
                const isCleanupStep = (test.options as any).__isCleanupStep === true;
                if (isSerialMode && serialDescribeFailures.get(describeName) && !isCleanupStep) {
                    const skippedResult: SpecTestResult = {
                        name: test.name,
                        describeName: describe.name,
                        status: 'skipped',
                        duration: 0,
                        startTime: new Date(),
                        endTime: new Date(),
                        steps: [],
                        screenshots: [],
                        tags: [],
                        skipReason: 'Skipped due to prior test failure in serial mode'
                    };
                    describeResult.tests.push(skippedResult);
                    describeResult.duration += 0;
                    suiteResult.totalTests++;
                    suiteResult.skippedTests++;
                    CSReporter.warn(`    ⊘ ${test.name} - skipped (serial dependency)`);
                    continue;
                }

                // Execute test (returns array for data-driven tests)
                const results = await this.executeTestWithADO(test, describe, parentDescribes, options);

                // Process each result (multiple for data-driven tests)
                let isFirstTestInDescribe = describeResult.tests.length === 0;
                for (const result of results) {
                    // Attach beforeAllSteps to the first test result in this describe
                    if (isFirstTestInDescribe && beforeAllSteps.length > 0) {
                        result.beforeAllSteps = beforeAllSteps;
                        isFirstTestInDescribe = false;
                    }
                    describeResult.tests.push(result);
                    describeResult.duration += result.duration;

                    // Aggregate to suite based on status
                    suiteResult.totalTests++;
                    if (result.status === 'passed') {
                        suiteResult.passedTests++;
                    } else if (result.status === 'failed' || result.status === 'unexpected-pass') {
                        suiteResult.failedTests++;
                        // Mark serial describe as failed
                        if (isSerialMode) {
                            serialDescribeFailures.set(describeName, true);
                            CSReporter.debug(`[SpecRunner] Serial describe "${describeName}" marked as failed`);
                        }
                    } else if (result.status === 'skipped' || result.status === 'fixme' || result.status === 'expected-failure') {
                        suiteResult.skippedTests++;
                    }
                }
            }

            // Execute afterAll hooks if present - with step tracking
            let afterAllSteps: SpecStepResult[] = [];
            if (describe.afterAll && describe.afterAll.length > 0) {
                CSReporter.debug(`[SpecRunner] Running afterAll hooks for: ${describeName}`);

                // Create step tracker for afterAll hooks
                const afterAllTracker = createStepTracker();
                afterAllTracker.setHookType('afterAll');
                setCurrentStepTracker(afterAllTracker);
                // IMPORTANT: Set instance tracker so createFixtures doesn't create a new one
                this.currentStepTracker = afterAllTracker;

                try {
                    const existingPage = this.browserManager?.getPage?.();
                    if (existingPage) {
                        const afterAllFixtures = await this.createFixtures({}, null, isSerialMode);
                        for (const hook of describe.afterAll) {
                            // Get hook title if available (named hooks)
                            const hookTitle = (hook as any).title || 'afterAll';
                            await afterAllTracker.step(`[afterAll] ${hookTitle}`);
                            try {
                                await hook(afterAllFixtures);
                                afterAllTracker.endStep();
                            } catch (hookError: any) {
                                afterAllTracker.failStep(hookError?.message || String(hookError));
                                throw hookError;
                            }
                        }
                        CSReporter.debug(`[SpecRunner] afterAll hooks completed for: ${describeName}`);
                    }
                } catch (error: any) {
                    CSReporter.error(`[SpecRunner] afterAll hook failed for ${describeName}: ${error.message}`);
                } finally {
                    // Collect afterAll steps
                    afterAllSteps = afterAllTracker.finalize();
                    setCurrentStepTracker(null);
                    this.currentStepTracker = null;  // Clear instance tracker
                }

                // Attach afterAllSteps to the last test result in this describe
                const describeResult = suiteResult.describes.find(d => d.name === describeName);
                if (describeResult && describeResult.tests.length > 0 && afterAllSteps.length > 0) {
                    const lastTest = describeResult.tests[describeResult.tests.length - 1];
                    lastTest.afterAllSteps = afterAllSteps;
                }
            }

            // At the end of a serial describe block, clear browser state (not close)
            // This ensures fresh state for the next describe block while reusing the browser
            if (isSerialMode && this.browserManager) {
                CSReporter.debug(`[SpecRunner] Clearing browser state after serial describe: ${describeName}`);
                const page = this.browserManager.getPage?.();
                const context = this.browserManager.getContext?.();

                if (page && context) {
                    try {
                        // Navigate to about:blank to leave current app
                        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });
                        // Clear cookies
                        await context.clearCookies();
                        // Clear permissions
                        await context.clearPermissions();
                        // Clear localStorage and sessionStorage
                        await page.evaluate(() => {
                            try {
                                localStorage.clear();
                                sessionStorage.clear();
                            } catch (e) {
                                // Ignore errors on about:blank
                            }
                        });
                        CSReporter.debug(`[SpecRunner] Browser state cleared after serial describe: ${describeName}`);
                    } catch (error: any) {
                        CSReporter.debug(`[SpecRunner] Failed to clear browser state: ${error.message}`);
                    }
                }
            }
        }

        suiteResult.endTime = new Date();
        return suiteResult;
    }

    /**
     * Run tests in parallel with collected tests
     */
    private async runParallelWithCollectedTests(
        specFiles: string[],
        collectedTests: Array<{
            test: RegisteredTest;
            describe: RegisteredDescribe;
            parentDescribes: RegisteredDescribe[];
            specFilePath: string;
        }>,
        options: SpecRunnerOptions
    ): Promise<SpecSuiteResult> {
        const workers = options.workers || this.config.getNumber('PARALLEL_WORKERS', 4);

        CSReporter.info(`[SpecRunner] Starting parallel execution with ${workers} worker processes`);
        CSReporter.info(`[SpecRunner] Found ${collectedTests.length} tests to run in parallel`);

        if (collectedTests.length === 0) {
            return this.createEmptySuiteResult(options);
        }

        // Use the parallel orchestrator with worker processes
        const { CSSpecParallelOrchestrator } = require('./CSSpecParallelOrchestrator');
        const orchestrator = new CSSpecParallelOrchestrator(workers);

        // Execute tests in parallel
        const results = await orchestrator.execute(specFiles, collectedTests, options);

        // Build suite result from worker results
        const suiteResult = this.createEmptySuiteResult(options);
        const describeMap = new Map<string, SpecDescribeResult>();

        // Create a lookup map for test/describe objects by test name
        const testLookup = new Map<string, {
            test: RegisteredTest;
            describe: RegisteredDescribe;
            parentDescribes: RegisteredDescribe[];
        }>();
        for (const { test, describe, parentDescribes } of collectedTests) {
            // Key: testName::describeName (unique identifier)
            const key = `${test.name}::${describe.name}`;
            testLookup.set(key, { test, describe, parentDescribes });
        }

        // Track data-driven test iterations for completion signaling
        const dataDrivenIterations = new Map<string, SpecTestResult[]>();

        // Process results from all workers
        for (const [workId, testResult] of results.entries()) {
            // Use originalTestName for lookup (for data-driven tests with replaced placeholders)
            const originalTestName = (testResult as any).originalTestName || testResult.name;
            const key = `${originalTestName}::${testResult.describeName}`;
            const testInfo = testLookup.get(key);

            if (testInfo) {
                // Report to ADO with proper tag separation
                await this.reportToADO(testResult, testInfo.test, testInfo.describe, testInfo.parentDescribes);

                // Track data-driven iterations
                if (testResult.iteration) {
                    if (!dataDrivenIterations.has(key)) {
                        dataDrivenIterations.set(key, []);
                    }
                    dataDrivenIterations.get(key)!.push(testResult);
                }
            } else {
                CSReporter.debug(`[SpecRunner] Could not find test info for: ${key}`);
            }

            // Get or create describe result
            const describeName = testResult.describeName || 'Default Suite';
            if (!describeMap.has(describeName)) {
                describeMap.set(describeName, {
                    name: describeName,
                    tests: [],
                    describes: [],
                    duration: 0,
                    tags: testResult.tags || []
                });
            }

            const describeResult = describeMap.get(describeName)!;
            describeResult.tests.push(testResult);
            describeResult.duration += testResult.duration;

            // Aggregate to suite
            suiteResult.totalTests++;
            if (testResult.status === 'passed') {
                suiteResult.passedTests++;
            } else if (testResult.status === 'failed') {
                suiteResult.failedTests++;
            } else if (testResult.status === 'skipped') {
                suiteResult.skippedTests++;
            }
        }

        // Signal completion for all data-driven tests
        for (const [key, iterations] of dataDrivenIterations.entries()) {
            const testInfo = testLookup.get(key);
            if (testInfo && iterations.length > 0) {
                CSReporter.debug(`[SpecRunner] Signaling completion for data-driven test: ${key} (${iterations.length} iterations)`);
                await this.signalDataDrivenComplete(
                    testInfo.test,
                    testInfo.describe,
                    testInfo.parentDescribes,
                    iterations[0]
                );
            }
        }

        // Add all describes to suite
        suiteResult.describes = Array.from(describeMap.values());

        // Add parallel metadata to suite
        (suiteResult as any).parallel = true;
        (suiteResult as any).workers = workers;

        suiteResult.endTime = new Date();
        return suiteResult;
    }

    /**
     * Execute a single test with ADO reporting
     * Returns array to support data-driven tests with multiple iterations
     */
    private async executeTestWithADO(
        test: RegisteredTest,
        describe: RegisteredDescribe,
        parentDescribes: RegisteredDescribe[],
        options: SpecRunnerOptions
    ): Promise<SpecTestResult[]> {
        // Execute the test (returns array for data-driven tests)
        // NOTE: executeSingleTest already calls reportToADO for each iteration
        const results = await this.executeTest(test, describe, parentDescribes, options);

        // For data-driven tests, signal completion to trigger aggregation and publishing
        // This must be called AFTER all iterations are reported (which happens in executeSingleTest)
        if (results.length > 0 && results[0].iteration) {
            await this.signalDataDrivenComplete(test, describe, parentDescribes, results[0]);
        }

        return results;
    }

    /**
     * Signal that all iterations of a data-driven test are complete
     * This triggers ADO to aggregate and publish the results
     */
    private async signalDataDrivenComplete(
        test: RegisteredTest,
        describe: RegisteredDescribe,
        parentDescribes: RegisteredDescribe[],
        sampleResult: SpecTestResult
    ): Promise<void> {
        if (!this.adoIntegration) {
            return;
        }

        try {
            // Build tags with proper priority (same as reportToADO)
            const testTags: string[] = [];
            if (test.options.tags) {
                const tags = Array.isArray(test.options.tags) ? test.options.tags : [test.options.tags];
                testTags.push(...tags.map(t => t.startsWith('@') ? t : `@${t}`));
            }

            const featureTags: string[] = [];
            if (describe.options.tags) {
                const tags = Array.isArray(describe.options.tags) ? describe.options.tags : [describe.options.tags];
                featureTags.push(...tags.map(t => t.startsWith('@') ? t : `@${t}`));
            }
            for (let i = parentDescribes.length - 1; i >= 0; i--) {
                const pd = parentDescribes[i];
                if (pd.options.tags) {
                    const tags = Array.isArray(pd.options.tags) ? pd.options.tags : [pd.options.tags];
                    featureTags.push(...tags.map(t => t.startsWith('@') ? t : `@${t}`));
                }
            }

            // Use test.name (original template name) to match the key used in reportToADO
            const scenario = { name: test.name, tags: testTags };
            const feature = { name: sampleResult.describeName, tags: featureTags };

            // Send 'completed' status to trigger aggregation and publishing
            await this.adoIntegration.afterScenario(
                scenario,
                feature,
                'completed',  // Special status to trigger data-driven result aggregation
                0,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined
            );

            CSReporter.debug(`[SpecRunner] Signaled data-driven test completion for: ${test.name}`);
        } catch (error: any) {
            CSReporter.debug(`[SpecRunner] Data-driven completion signal error: ${error.message}`);
        }
    }

    /**
     * Run tests sequentially (legacy - kept for compatibility)
     */
    private async runSequential(specFiles: string[], options: SpecRunnerOptions): Promise<SpecSuiteResult> {
        const suiteResult: SpecSuiteResult = this.createEmptySuiteResult(options);

        for (const specFile of specFiles) {
            CSReporter.info(`[SpecRunner] Loading: ${path.basename(specFile)}`);

            try {
                // Load and execute spec file
                const describes = await this.loadSpecFile(specFile);

                for (const describe of describes) {
                    const describeResult = await this.executeDescribe(describe, options);
                    suiteResult.describes.push(describeResult);

                    // Aggregate results
                    this.aggregateResults(suiteResult, describeResult);
                }
            } catch (error: any) {
                CSReporter.error(`[SpecRunner] Error loading ${specFile}: ${error.message}`);
            }
        }

        suiteResult.endTime = new Date();
        return suiteResult;
    }

    /**
     * Run tests in parallel using worker processes
     * Each worker gets its own browser instance for true isolation
     */
    private async runParallel(specFiles: string[], options: SpecRunnerOptions): Promise<SpecSuiteResult> {
        const workers = options.workers || this.config.getNumber('PARALLEL_WORKERS', 4);

        CSReporter.info(`[SpecRunner] Starting parallel execution with ${workers} worker processes`);

        // Collect all tests from all spec files
        const collectedTests: Array<{
            test: RegisteredTest;
            describe: RegisteredDescribe;
            parentDescribes: RegisteredDescribe[];
            specFilePath: string;
        }> = [];

        for (const specFile of specFiles) {
            CSReporter.info(`[SpecRunner] Loading: ${path.basename(specFile)}`);
            const describes = await this.loadSpecFile(specFile);

            const collectTests = (describe: RegisteredDescribe, parents: RegisteredDescribe[] = []) => {
                for (const test of describe.tests) {
                    // Check if test matches filters (including enabled flag)
                    if (this.matchesFilters(test, describe, options, parents)) {
                        collectedTests.push({
                            test,
                            describe,
                            parentDescribes: parents,
                            specFilePath: specFile
                        });
                    }
                }
                for (const nested of describe.describes) {
                    collectTests(nested, [...parents, describe]);
                }
            };

            for (const describe of describes) {
                collectTests(describe);
            }
        }

        CSReporter.info(`[SpecRunner] Found ${collectedTests.length} tests to run in parallel`);

        if (collectedTests.length === 0) {
            return this.createEmptySuiteResult(options);
        }

        // Use the parallel orchestrator with worker processes
        const { CSSpecParallelOrchestrator } = require('./CSSpecParallelOrchestrator');
        const orchestrator = new CSSpecParallelOrchestrator(workers);

        // Execute tests in parallel
        const results = await orchestrator.execute(specFiles, collectedTests, options);

        // Build suite result from worker results
        const suiteResult = this.createEmptySuiteResult(options);
        const describeMap = new Map<string, SpecDescribeResult>();

        // Process results from all workers
        for (const [workId, testResult] of results.entries()) {
            // Get or create describe result
            let describeResult = describeMap.get(testResult.describeName);
            if (!describeResult) {
                describeResult = {
                    name: testResult.describeName,
                    tests: [],
                    describes: [],
                    duration: 0,
                    tags: []
                };
                describeMap.set(testResult.describeName, describeResult);
                suiteResult.describes.push(describeResult);
            }

            // Add test result to describe
            describeResult.tests.push(testResult);
            describeResult.duration += testResult.duration;

            // Update suite totals
            suiteResult.totalTests++;
            if (testResult.status === 'passed') {
                suiteResult.passedTests++;
            } else if (testResult.status === 'failed') {
                suiteResult.failedTests++;
                this.hasAnyFailures = true;
            } else if (testResult.status === 'skipped') {
                suiteResult.skippedTests++;
            }
        }

        suiteResult.endTime = new Date();

        // Add parallel execution metadata
        (suiteResult as any).parallel = true;
        (suiteResult as any).workers = workers;

        return suiteResult;
    }

    /**
     * Load and parse a spec file
     */
    private async loadSpecFile(filePath: string): Promise<RegisteredDescribe[]> {
        // Import the CSSpecDescribe module to register describe/test functions
        const { CSSpecDescribe } = require('./CSSpecDescribe');
        const registry = CSSpecDescribe.getInstance();

        // Clear previous registrations
        registry.clear();

        // Load the spec file
        require(filePath);

        // Get registered describes
        return registry.getRegisteredDescribes();
    }

    /**
     * Execute a describe block
     */
    private async executeDescribe(
        describe: RegisteredDescribe,
        options: SpecRunnerOptions,
        parentDescribes: RegisteredDescribe[] = []
    ): Promise<SpecDescribeResult> {
        const startTime = Date.now();
        const result: SpecDescribeResult = {
            name: describe.name,
            tests: [],
            describes: [],
            duration: 0,
            tags: this.adoResolver.parseTags(describe.options.tags).customTags
        };

        CSReporter.info(`[SpecRunner] Describe: ${describe.name}`);
        const isSerialMode = describe.options.mode === 'serial';
        let describeFixtures: SpecFixtures | null = null;


        try {
            // If there are beforeAll hooks that need fixtures, create them first
            if (describe.beforeAll.length > 0) {
                // For serial mode or any describe with beforeAll, ensure browser is ready
                if (isSerialMode || describe.beforeAll.length > 0) {
                    // Ensure browser manager is initialized
                    await this.ensureBrowserManager();

                    // Check if browser is already running (reuse from previous describe)
                    let existingPage: any = null;
                    try {
                        existingPage = this.browserManager?.getPage?.();
                    } catch (e) {
                        // Page not initialized yet - this is expected
                    }

                    if (!existingPage) {
                        // Launch browser - this creates browser, context, and page
                        CSReporter.debug(`[SpecRunner] Launching browser for beforeAll hooks: ${describe.name}`);
                        await this.browserManager?.launch?.();
                    } else {
                        CSReporter.debug(`[SpecRunner] Using existing browser for beforeAll hooks: ${describe.name}`);
                    }

                    // Create fixtures for beforeAll/afterAll hooks
                    describeFixtures = await this.createFixtures({}, null, isSerialMode);
                }

                // Execute beforeAll hooks with fixtures
                CSReporter.debug(`[SpecRunner] Running beforeAll hooks for: ${describe.name}`);
                await this.executeHooksWithFixtures(describe.beforeAll, describeFixtures!, 'beforeAll', describe.name);
            }

            // Execute tests
            for (const test of describe.tests) {
                // Check if test matches filters (including enabled flag)
                if (!this.matchesFilters(test, describe, options, parentDescribes)) {
                    continue;
                }

                const testResults = await this.executeTest(test, describe, parentDescribes, options);
                result.tests.push(...testResults);
            }

            // Execute nested describes
            for (const nestedDescribe of describe.describes) {
                const nestedResult = await this.executeDescribe(
                    nestedDescribe,
                    options,
                    [...parentDescribes, describe]
                );
                result.describes.push(nestedResult);
            }

            // Execute afterAll hooks with fixtures (if we created them)
            if (describe.afterAll.length > 0) {
                if (!describeFixtures) {
                    // Create fixtures if not already created (for afterAll only scenarios)
                    const existingPage = this.browserManager?.getPage?.();
                    if (existingPage) {
                        describeFixtures = await this.createFixtures({}, null, isSerialMode);
                    }
                }
                if (describeFixtures) {
                    await this.executeHooksWithFixtures(describe.afterAll, describeFixtures, 'afterAll', describe.name);
                } else {
                    // Fallback to no-fixtures execution (shouldn't happen often)
                    await this.executeHooks(describe.afterAll, 'afterAll', describe.name);
                }
            }

        } catch (error: any) {
            CSReporter.error(`[SpecRunner] Error in describe "${describe.name}": ${error.message}`);
        }

        result.duration = Date.now() - startTime;
        return result;
    }

    /**
     * Execute a single test (may run multiple times for data-driven)
     */
    private async executeTest(
        test: RegisteredTest,
        describe: RegisteredDescribe,
        parentDescribes: RegisteredDescribe[],
        options: SpecRunnerOptions
    ): Promise<SpecTestResult[]> {
        const results: SpecTestResult[] = [];

        // Check if test has its own dataSource vs inheriting from describe
        const testHasOwnDataSource = !!test.options.dataSource;
        const describeHasDataSource = !!describe.options.dataSource;

        // Merge data sources from describe and test
        const dataSource = this.dataIterator.mergeDataSources(
            describe.options.dataSource,
            test.options.dataSource
        );

        // Load data if data source is configured
        let dataRows: SpecDataRow[] = [];
        let shouldIterateWithData = true;

        if (dataSource) {
            try {
                dataRows = await this.dataIterator.loadData(dataSource);
            } catch (error: any) {
                CSReporter.error(`[SpecRunner] Failed to load data for test "${test.name}": ${error.message}`);
                // Return single failed result
                results.push(this.createFailedResult(test.name, describe.name, error.message));
                return results;
            }

            // Determine if test should use data iterations
            // Priority: 1) Test has own dataSource - always iterate
            //           2) useData option - explicit control
            //           3) Auto-detect - check if test function uses 'data' parameter
            if (!testHasOwnDataSource && describeHasDataSource && dataRows.length > 0) {
                const useData = test.options.useData;

                if (useData === false) {
                    // Explicit opt-out - run once without data iterations
                    CSReporter.debug(`[SpecRunner] Test "${test.name}" has useData: false, skipping data iterations`);
                    shouldIterateWithData = false;
                } else if (useData === undefined) {
                    // Auto-detect: check if test function uses 'data' parameter
                    const usesData = this.testUsesDataFixture(test.fn);
                    if (!usesData) {
                        CSReporter.debug(`[SpecRunner] Test "${test.name}" doesn't use 'data' fixture, skipping data iterations`);
                        shouldIterateWithData = false;
                    }
                }
                // useData === true: iterate with data (default behavior)
            }
        }

        // If no data or test opted out, run once with empty data
        if (dataRows.length === 0 || !shouldIterateWithData) {
            dataRows = [{}];
        }

        // Execute for each data row
        for (let i = 0; i < dataRows.length; i++) {
            const data = dataRows[i];
            // Always create iteration info when there's data (even for single row)
            // This ensures testData is shown in reports for all data-driven tests
            const hasActualData = Object.keys(data).length > 0;
            const iteration = hasActualData
                ? this.dataIterator.createIterationInfo(data, i, dataRows.length, dataSource)
                : null;

            const testName = iteration
                ? this.dataIterator.interpolateTestName(test.name, data, iteration)
                : test.name;

            const result = await this.executeSingleTest(
                test,
                describe,
                parentDescribes,
                options,
                data,
                iteration,
                testName
            );
            results.push(result);
        }

        return results;
    }

    /**
     * Execute a single test instance
     * Handles runtime annotations (skip, fixme, fail, slow) and test.info() API
     */
    private async executeSingleTest(
        test: RegisteredTest,
        describe: RegisteredDescribe,
        parentDescribes: RegisteredDescribe[],
        options: SpecRunnerOptions,
        data: SpecDataRow,
        iteration: any,
        testName: string
    ): Promise<SpecTestResult> {
        const startTime = Date.now();

        // Create step tracker for this test
        this.currentStepTracker = createStepTracker();

        const result: SpecTestResult = {
            name: testName,
            describeName: describe.name,
            status: 'passed',
            duration: 0,
            startTime: new Date(),
            endTime: new Date(),
            steps: [],
            screenshots: [],
            tags: []
        };

        // Resolve ADO tags
        const resolvedTags = this.adoResolver.resolveADOTags(
            test.options,
            describe.options,
            parentDescribes.map(d => d.options)
        );
        result.tags = this.adoResolver.getAllTags(resolvedTags);

        if (iteration) {
            result.iteration = iteration;
        }

        CSReporter.info(`  ▶ ${testName}`);

        // Check decorator-level skip
        if (test.options.skip) {
            result.status = 'skipped';
            result.skipReason = typeof test.options.skip === 'string' ? test.options.skip : 'Skipped';
            result.error = result.skipReason;
            CSReporter.warn(`    ⊘ Skipped: ${result.skipReason}`);
            return result;
        }

        // Check decorator-level fixme
        if (test.options.fixme) {
            result.status = 'fixme';
            result.skipReason = typeof test.options.fixme === 'string' ? test.options.fixme : 'Marked as fixme';
            result.error = result.skipReason;
            CSReporter.warn(`    ⚠ Fixme: ${result.skipReason}`);
            return result;
        }

        // Check decorator-level enabled (false means skip)
        if (test.options.enabled === false) {
            result.status = 'skipped';
            result.skipReason = 'Test disabled (enabled: false)';
            result.error = result.skipReason;
            CSReporter.warn(`    ⊘ Disabled`);
            return result;
        }

        // Check dependencies (dependsOn option)
        // Skip cleanup steps from dependency checks - they always run
        const isCleanupStep = (test.options as any).__isCleanupStep === true;
        if (test.options.dependsOn && !isCleanupStep) {
            const depCheck = this.dependencyTracker.checkDependencies(test.options.dependsOn);
            if (!depCheck.passed) {
                result.status = 'skipped';
                result.skipReason = `Dependency failed: ${depCheck.reasons.join('; ')}`;
                result.error = result.skipReason;
                CSReporter.warn(`    ⊘ Skipped (dependency failed): ${depCheck.failedDeps.join(', ')}`);
                // Still record this result for downstream dependencies
                this.dependencyTracker.recordResult(testName, result.tags, result.status, result.error);
                return result;
            }
        }

        // Create runtime state for test.skip(), test.fixme(), test.fail(), test.slow()
        const runtimeState = createRuntimeState();

        // Check decorator-level expectedToFail and slow
        if (test.options.expectedToFail) {
            runtimeState.expectedToFail = true;
            runtimeState.expectedFailReason = typeof test.options.expectedToFail === 'string'
                ? test.options.expectedToFail : 'Expected to fail';
        }
        if (test.options.slow) {
            runtimeState.isSlow = true;
            runtimeState.slowReason = typeof test.options.slow === 'string' ? test.options.slow : 'Marked as slow';
        }

        // Calculate timeout (with slow modifier)
        let baseTimeout = test.options.timeout ?? describe.options.timeout ?? options.timeout ?? 30000;
        if (runtimeState.isSlow) {
            baseTimeout *= 3; // Playwright triples timeout for slow tests
            CSReporter.debug(`[SpecRunner] Slow test - timeout tripled to ${baseTimeout}ms`);
        }

        // Create test info for test.info() API
        const dirs = this.resultsManager.getDirectories();
        const testInfo = createTestInfo({
            title: test.name,
            titlePath: [...parentDescribes.map(d => d.name), describe.name, test.name],
            file: test.describePath[0] || '',
            retry: 0,
            parallelIndex: 0,
            project: options.project,
            timeout: baseTimeout,
            outputDir: dirs.base,
            snapshotDir: dirs.screenshots,
            runtimeState
        });

        // Set global state for runtime annotations
        setCurrentTestState(runtimeState);
        setCurrentTestInfo(testInfo);

        // Retry logic
        const retries = test.options.retries ?? describe.options.retries ?? options.retries ?? 0;
        let lastError: Error | null = null;
        let testPassed = false;

        try {
            for (let attempt = 0; attempt <= retries; attempt++) {
                if (attempt > 0) {
                    CSReporter.info(`    ↻ Retry attempt ${attempt}/${retries}`);
                    result.retryAttempt = attempt;
                    (testInfo as any).retry = attempt;
                }

                try {
                    // Initialize browser (reuse if already launched with valid page)
                    await this.ensureBrowserManager();
                    const hasBrowser = this.browserManager.isLaunched?.() || this.browserManager.browser;
                    let hasPage = false;
                    try {
                        hasPage = !!this.browserManager.getPage?.();
                    } catch (e) {
                        // Page not available
                    }

                    if (!hasBrowser || !hasPage) {
                        // Launch or relaunch browser to get a valid page
                        CSReporter.debug('[SpecRunner] Launching browser (no valid page available)');
                        await this.browserManager.launch();
                    } else {
                        CSReporter.debug('[SpecRunner] Reusing existing browser');
                    }

                    // Create fixtures (preserve context in serial mode)
                    const isSerialMode = describe.options.mode === 'serial';
                    const fixtures = await this.createFixtures(data, iteration, isSerialMode);

                    // Execute beforeEach hooks from ALL parent describes (outermost to innermost) - with step tracking
                    const beforeEachTracker = createStepTracker();
                    beforeEachTracker.setHookType('beforeEach');
                    setCurrentStepTracker(beforeEachTracker);

                    try {
                        for (const parentDescribe of parentDescribes) {
                            if (parentDescribe.beforeEach.length > 0) {
                                for (const hook of parentDescribe.beforeEach) {
                                    const hookTitle = (hook as any).title || `beforeEach (${parentDescribe.name})`;
                                    await beforeEachTracker.step(hookTitle);
                                    try {
                                        await hook(fixtures);
                                        beforeEachTracker.endStep();
                                    } catch (hookError: any) {
                                        beforeEachTracker.failStep(hookError?.message || String(hookError));
                                        throw hookError;
                                    }
                                }
                            }
                        }
                        // Execute immediate describe's beforeEach hooks
                        for (const hook of describe.beforeEach) {
                            const hookTitle = (hook as any).title || `beforeEach (${describe.name})`;
                            await beforeEachTracker.step(hookTitle);
                            try {
                                await hook(fixtures);
                                beforeEachTracker.endStep();
                            } catch (hookError: any) {
                                beforeEachTracker.failStep(hookError?.message || String(hookError));
                                throw hookError;
                            }
                        }
                    } finally {
                        result.beforeEachSteps = beforeEachTracker.finalize();
                        // Switch to test step tracker for main test execution
                        setCurrentStepTracker(this.currentStepTracker);
                    }

                    // Check for runtime skip/fixme before test execution continues
                    if (runtimeState.shouldSkip) {
                        result.status = 'skipped';
                        result.skipReason = runtimeState.skipReason || 'Skipped at runtime';
                        throw new Error(`SKIP: ${result.skipReason}`);
                    }
                    if (runtimeState.isFixme) {
                        result.status = 'fixme';
                        result.skipReason = runtimeState.fixmeReason || 'Marked as fixme at runtime';
                        throw new Error(`FIXME: ${result.skipReason}`);
                    }

                    // Get effective timeout (may have been changed by test.setTimeout())
                    const effectiveTimeout = runtimeState.customTimeout ?? baseTimeout;

                    // Execute test
                    await Promise.race([
                        test.fn(fixtures),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error(`Test timeout exceeded (${effectiveTimeout}ms)`)), effectiveTimeout)
                        )
                    ]);

                    // Check for runtime skip/fixme after test execution
                    if (runtimeState.shouldSkip) {
                        result.status = 'skipped';
                        result.skipReason = runtimeState.skipReason || 'Skipped at runtime';
                        CSReporter.warn(`    ⊘ Skipped: ${result.skipReason}`);
                        break;
                    }
                    if (runtimeState.isFixme) {
                        result.status = 'fixme';
                        result.skipReason = runtimeState.fixmeReason || 'Marked as fixme';
                        CSReporter.warn(`    ⚠ Fixme: ${result.skipReason}`);
                        break;
                    }

                    // Execute afterEach hooks (innermost to outermost) - with step tracking
                    const afterEachTracker = createStepTracker();
                    afterEachTracker.setHookType('afterEach');
                    setCurrentStepTracker(afterEachTracker);

                    try {
                        // Execute immediate describe's afterEach hooks first
                        for (const hook of describe.afterEach) {
                            const hookTitle = (hook as any).title || `afterEach (${describe.name})`;
                            await afterEachTracker.step(hookTitle);
                            try {
                                await hook(fixtures);
                                afterEachTracker.endStep();
                            } catch (hookError: any) {
                                afterEachTracker.failStep(hookError?.message || String(hookError));
                                throw hookError;
                            }
                        }
                        // Execute parent describes' afterEach hooks (innermost to outermost)
                        for (let i = parentDescribes.length - 1; i >= 0; i--) {
                            const parentDescribe = parentDescribes[i];
                            if (parentDescribe.afterEach.length > 0) {
                                for (const hook of parentDescribe.afterEach) {
                                    const hookTitle = (hook as any).title || `afterEach (${parentDescribe.name})`;
                                    await afterEachTracker.step(hookTitle);
                                    try {
                                        await hook(fixtures);
                                        afterEachTracker.endStep();
                                    } catch (hookError: any) {
                                        afterEachTracker.failStep(hookError?.message || String(hookError));
                                        throw hookError;
                                    }
                                }
                            }
                        }
                    } finally {
                        result.afterEachSteps = afterEachTracker.finalize();
                        setCurrentStepTracker(null);
                    }

                    // Test passed
                    testPassed = true;
                    lastError = null;
                    break;

                } catch (error: any) {
                    // Check if this is a skip/fixme signal (thrown by test.skip() or test.fixme())
                    if (error.message.startsWith('SKIP:')) {
                        result.status = 'skipped';
                        result.skipReason = runtimeState.skipReason || error.message.replace('SKIP: ', '');
                        CSReporter.warn(`    ⊘ ${testName} - Skipped: ${result.skipReason}`);
                        break;
                    }
                    if (error.message.startsWith('FIXME:')) {
                        result.status = 'fixme';
                        result.skipReason = runtimeState.fixmeReason || error.message.replace('FIXME: ', '');
                        CSReporter.warn(`    ⚠ ${testName} - Fixme: ${result.skipReason}`);
                        break;
                    }

                    lastError = error;
                    (testInfo as any)._setError(error);

                    // Capture screenshot on failure IMMEDIATELY
                    try {
                        const page = this.browserManager?.getPage?.();
                        if (page && !page.isClosed()) {
                            await page.waitForTimeout(100);
                            const screenshotResult = await this.captureFailureScreenshot(testName);
                            if (screenshotResult) {
                                result.screenshots.push(screenshotResult.fullPath);
                                if (this.currentStepTracker) {
                                    this.currentStepTracker.screenshot(screenshotResult.filename);
                                }
                            }
                        }
                    } catch (screenshotError) {
                        CSReporter.debug(`Failed to capture screenshot: ${screenshotError}`);
                    }

                    // Mark current step as failed
                    if (this.currentStepTracker) {
                        this.currentStepTracker.failStep(error.message);
                    }

                    // Save trace on failure
                    try {
                        await this.browserManager?.saveTraceIfNeeded?.('failed');
                    } catch (traceError) {
                        CSReporter.debug(`Failed to save trace: ${traceError}`);
                    }

                    if (attempt < retries) {
                        this.currentStepTracker?.clear();
                        await this.browserManager?.clearContextAndReauthenticate?.({ clearOnly: true });
                    }
                }
            }

            // Determine final status based on runtime state and test outcome
            if (result.status === 'skipped' || result.status === 'fixme') {
                // Already set above
            } else if (runtimeState.expectedToFail) {
                // Test was expected to fail
                if (testPassed) {
                    // Unexpected pass - this is an error!
                    result.status = 'unexpected-pass';
                    result.error = `Test was expected to fail but passed. Reason: ${runtimeState.expectedFailReason}`;
                    CSReporter.error(`    ✗ Unexpected pass: ${runtimeState.expectedFailReason}`);
                    this.hasAnyFailures = true;
                } else {
                    // Expected failure - test failed as expected
                    result.status = 'expected-failure';
                    result.error = lastError?.message;
                    result.skipReason = runtimeState.expectedFailReason;
                    CSReporter.info(`    ✓ Expected failure: ${runtimeState.expectedFailReason}`);
                }
            } else if (testPassed) {
                result.status = 'passed';
                CSReporter.pass(`    ✓ Passed`);
            } else {
                result.status = 'failed';
                result.error = lastError?.message;
                result.stack = lastError?.stack;
                CSReporter.error(`    ✗ Failed: ${lastError?.message}`);
                this.hasAnyFailures = true;
            }

            // Add custom annotations and attachments from test.info()
            if (runtimeState.annotations.length > 0) {
                result.customAnnotations = runtimeState.annotations;
            }
            if (runtimeState.attachments.length > 0) {
                result.attachments = runtimeState.attachments;
            }

        } finally {
            // Clear global state
            setCurrentTestState(null);
            setCurrentTestInfo(null);
        }

        result.endTime = new Date();
        result.duration = Date.now() - startTime;

        // Collect tracked steps
        if (this.currentStepTracker) {
            result.steps = this.currentStepTracker.finalize();
        }

        // Add used columns info to iteration
        if (result.iteration) {
            (result.iteration as any).usedColumns = this.getUsedDataColumns();
        }

        // Collect artifacts from browser manager
        await this.collectArtifacts(result, testName);

        // Perform test cleanup (preserve browser state in serial mode)
        const cleanupStatus = (result.status === 'failed' || result.status === 'unexpected-pass') ? 'failed' : 'passed';
        const isSerialMode = describe.options.mode === 'serial';
        await this.performTestCleanup(cleanupStatus, isSerialMode);

        // Report to ADO
        await this.reportToADO(result, test, describe, parentDescribes);

        // Record result for dependency tracking
        this.dependencyTracker.recordResult(testName, result.tags, result.status, result.error);

        return result;
    }

    /**
     * Perform cleanup after each test (equivalent to BDD's performScenarioCleanup)
     * @param testStatus - 'passed' or 'failed'
     * @param preserveBrowserState - If true, don't clear browser state (for serial mode)
     */
    private async performTestCleanup(testStatus: 'passed' | 'failed', preserveBrowserState: boolean = false): Promise<void> {
        try {
            if (!this.browserManager) return;

            const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);
            const clearStateOnReuse = this.config.getBoolean('BROWSER_REUSE_CLEAR_STATE', true);
            const closeAfterTests = this.config.getNumber('BROWSER_REUSE_CLOSE_AFTER_SCENARIOS', 0);

            if (browserReuseEnabled) {
                this.testCountForReuse++;

                // Check if we should close browser after N tests
                const shouldCloseBrowser = closeAfterTests > 0 && this.testCountForReuse >= closeAfterTests;

                if (shouldCloseBrowser && !preserveBrowserState) {
                    CSReporter.debug(`[SpecRunner] Closing browser after ${this.testCountForReuse} tests`);
                    await this.browserManager.close?.(testStatus);
                    this.testCountForReuse = 0;
                } else if (clearStateOnReuse && !preserveBrowserState) {
                    // Keep browser open but clear state (NOT in serial mode)
                    CSReporter.debug('[SpecRunner] Clearing browser state for reuse');

                    const page = this.browserManager.getPage?.();
                    const context = this.browserManager.getContext?.();

                    if (page && context) {
                        try {
                            // Step 1: Navigate to about:blank to leave current app
                            await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });

                            // Step 2: Clear cookies at context level
                            await context.clearCookies();

                            // Step 3: Clear permissions
                            await context.clearPermissions();

                            // Step 4: Clear localStorage and sessionStorage
                            await page.evaluate(() => {
                                try {
                                    localStorage.clear();
                                    sessionStorage.clear();
                                } catch (e) {
                                    // Ignore errors on about:blank
                                }
                            });

                            // Step 5: Clear saved browser state
                            this.browserManager.clearBrowserState?.();

                            CSReporter.debug('[SpecRunner] Browser state cleared for reuse');
                        } catch (error: any) {
                            CSReporter.debug(`[SpecRunner] Failed to clear browser state: ${error.message}`);
                        }
                    }

                    // Restart trace for next test
                    await this.browserManager.restartTraceForNextScenario?.();
                } else if (preserveBrowserState) {
                    // Serial mode: preserve browser state, just restart trace
                    CSReporter.debug('[SpecRunner] Serial mode: preserving browser state');
                    await this.browserManager.restartTraceForNextScenario?.();
                }
            } else {
                // No reuse enabled
                if (preserveBrowserState) {
                    // Serial mode: keep browser open even without reuse setting
                    CSReporter.debug('[SpecRunner] Serial mode: keeping browser open');
                } else {
                    // Close browser after each test
                    await this.browserManager.close?.(testStatus);
                }
            }
        } catch (error: any) {
            CSReporter.debug(`[SpecRunner] Test cleanup error: ${error.message}`);
        }
    }

    /**
     * Collect artifacts (screenshots, videos, HAR, traces) from browser manager
     */
    private async collectArtifacts(result: SpecTestResult, testName: string): Promise<void> {
        try {
            if (!this.browserManager) return;

            const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);

            // Get session artifacts from browser manager
            const artifacts = await this.browserManager.getSessionArtifacts?.();
            if (artifacts) {
                // Screenshots
                if (artifacts.screenshots && artifacts.screenshots.length > 0) {
                    for (const screenshot of artifacts.screenshots) {
                        if (!result.screenshots.includes(screenshot)) {
                            result.screenshots.push(screenshot);
                        }
                    }
                }

                // Traces (collected per-test via saveTraceIfNeeded)
                if (artifacts.traces && artifacts.traces.length > 0) {
                    result.trace = artifacts.traces[artifacts.traces.length - 1]; // Get latest trace
                }
            }

            if (browserReuseEnabled) {
                // With browser reuse: don't close context, just restart trace for next test
                // Video and HAR accumulate across the session
                await this.browserManager.restartTraceForNextScenario?.();
            } else {
                // Without browser reuse: close context and collect all artifacts
                const contextArtifacts = await this.browserManager.closeContextAndCollectArtifacts?.(result.status === 'failed');
                if (contextArtifacts) {
                    if (contextArtifacts.video && !result.video) {
                        result.video = contextArtifacts.video;
                    }
                    if (contextArtifacts.trace && !result.trace) {
                        result.trace = contextArtifacts.trace;
                    }
                    if (contextArtifacts.har && !result.har) {
                        result.har = contextArtifacts.har;
                    }
                }
            }

        } catch (error: any) {
            CSReporter.debug(`[SpecRunner] Failed to collect artifacts: ${error.message}`);
        }
    }

    /** Track which data columns are accessed during test execution */
    private usedDataColumns: Set<string> = new Set();

    /**
     * Create a tracked data object that records which columns are accessed
     */
    private createTrackedData(data: SpecDataRow): SpecDataRow {
        this.usedDataColumns.clear();

        if (!data || Object.keys(data).length === 0) {
            return data;
        }

        const tracker = this.usedDataColumns;
        return new Proxy(data, {
            get(target, prop: string) {
                if (prop in target && typeof prop === 'string') {
                    tracker.add(prop);
                }
                return target[prop];
            },
            ownKeys(target) {
                return Object.keys(target);
            },
            getOwnPropertyDescriptor(target, prop) {
                return Object.getOwnPropertyDescriptor(target, prop);
            }
        });
    }

    /**
     * Get the list of columns that were accessed during test execution
     */
    private getUsedDataColumns(): string[] {
        return Array.from(this.usedDataColumns);
    }

    /**
     * Create fixtures for test
     * @param data - Data row for data-driven tests
     * @param iteration - Iteration info
     * @param preserveContext - If true, don't clear context (for serial mode)
     */
    private async createFixtures(data: SpecDataRow, iteration: any, preserveContext: boolean = false): Promise<SpecFixtures> {
        // Lazy load dependencies
        if (!CSScenarioContext) {
            CSScenarioContext = require('../bdd/CSScenarioContext').CSScenarioContext;
        }
        if (!CSExpect) {
            CSExpect = require('../assertions/CSExpect').CSExpect;
        }
        if (!CSAssert) {
            CSAssert = require('../assertions/CSAssert').CSAssert;
        }
        if (!CSCrossDomainNavigationHandler) {
            CSCrossDomainNavigationHandler = require('../navigation/CSCrossDomainNavigationHandler').CSCrossDomainNavigationHandler;
        }

        const ctx = CSScenarioContext.getInstance();
        // Only clear context if not in serial mode (preserveContext = false)
        // In serial mode, context is shared between tests in the same describe block
        if (!preserveContext) {
            ctx.clear();
        }

        // Get page object
        let page: any = null;
        try {
            page = this.browserManager?.getPage?.();
        } catch (e: any) {
            CSReporter.debug(`[SpecRunner] getPage failed: ${e.message}`);
        }

        if (!page) {
            CSReporter.debug(`[SpecRunner] No page available for fixtures - page objects will be undefined`);
        }
        const pageFixtures = page ? await this.pageInjector.createPageFixtures(page) : {};

        // Create cross-domain navigation handler for the page
        let crossDomainHandler: any = null;
        if (page && this.config.getBoolean('CROSS_DOMAIN_NAVIGATION_ENABLED', true)) {
            crossDomainHandler = new CSCrossDomainNavigationHandler(page);
        }

        // Create navigate helper function with cross-domain support
        // Uses dynamic page access via browserManager to support browser switching
        const navigate = async (url: string): Promise<void> => {
            // Get current page dynamically from browserManager (supports browser switching)
            const currentPage = this.browserManager?.getPage?.();
            if (!currentPage) {
                throw new Error('Browser not initialized. Ensure test is running with browser context.');
            }

            CSReporter.info(`Navigating to: ${url}`);

            if (crossDomainHandler) {
                // Reset handler state and set target domain
                crossDomainHandler.reset();
                crossDomainHandler.setTargetDomain(url);
                crossDomainHandler.setOriginalDomain(url);
            }

            // Navigate to URL using current page (dynamic)
            await currentPage.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
            });

            // Handle cross-domain authentication redirects
            if (crossDomainHandler) {
                await crossDomainHandler.handleInitialAuthRedirect(url);

                if (crossDomainHandler.isInCrossDomainNavigation()) {
                    CSReporter.info('Detected cross-domain authentication redirect, waiting for completion...');
                    await crossDomainHandler.forceWaitForNavigation();
                }
            } else {
                // Fallback: wait for page load using current page (dynamic)
                await currentPage.waitForLoadState('load', {
                    timeout: this.config.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
                });
            }
        };

        // Create step tracker instance for this test
        const stepTracker = this.currentStepTracker || createStepTracker();

        // Use tracked data to monitor which columns are accessed during test execution
        const trackedData = this.createTrackedData(data || {});

        // Create base fixtures object
        const fixtures: SpecFixtures = {
            config: this.config,
            ctx,
            data: trackedData,
            iteration: iteration || null,
            reporter: CSReporter,
            stepTracker,
            api: null, // Lazy loaded when accessed
            db: null,  // Lazy loaded when accessed
            ado: this.adoIntegration,
            expect: CSExpect.getInstance(),
            assert: CSAssert.getInstance(),
            browserManager: this.browserManager,
            page, // Initial page reference (see dynamic getter below)
            crossDomainHandler,
            navigate,
            ...pageFixtures
        };

        // Add dynamic page getter to support browser switching
        // This allows tests to access the current page after browser switch via fixtures.page
        const browserManagerRef = this.browserManager;
        Object.defineProperty(fixtures, 'page', {
            get: function() {
                try {
                    return browserManagerRef?.getPage?.();
                } catch (e) {
                    return null;
                }
            },
            enumerable: true,
            configurable: true
        });

        return fixtures;
    }

    /**
     * Execute hooks
     */
    private async executeHooks(
        hooks: Function[],
        type: string,
        context: string
    ): Promise<void> {
        for (const hook of hooks) {
            try {
                await hook();
            } catch (error: any) {
                CSReporter.error(`[SpecRunner] ${type} hook failed in ${context}: ${error.message}`);
                throw error;
            }
        }
    }

    /**
     * Execute hooks with fixtures
     */
    private async executeHooksWithFixtures(
        hooks: Function[],
        fixtures: SpecFixtures,
        type: string,
        context: string
    ): Promise<void> {
        for (const hook of hooks) {
            try {
                await hook(fixtures);
            } catch (error: any) {
                CSReporter.error(`[SpecRunner] ${type} hook failed in ${context}: ${error.message}`);
                throw error;
            }
        }
    }

    /**
     * Check if test matches filters
     */
    private matchesFilters(
        test: RegisteredTest,
        describe: RegisteredDescribe,
        options: SpecRunnerOptions,
        parentDescribes?: RegisteredDescribe[]
    ): boolean {
        // Check enabled flag on test - default is true (enabled)
        if (test.options.enabled === false) {
            return false;
        }

        // Check enabled flag on immediate describe - default is true (enabled)
        if (describe.options.enabled === false) {
            return false;
        }

        // Check enabled flag on parent describes - if any parent is disabled, skip
        if (parentDescribes) {
            for (const pd of parentDescribes) {
                if (pd.options.enabled === false) {
                    return false;
                }
            }
        }

        // Check grep filter
        if (options.grep) {
            const pattern = new RegExp(options.grep, 'i');
            if (!pattern.test(test.name) && !pattern.test(describe.name)) {
                return false;
            }
        }

        // Check specific test name(s) - supports comma-separated values
        if (options.test) {
            const testNames = options.test.split(',').map(t => t.trim());
            if (!testNames.includes(test.name)) {
                return false;
            }
        }

        // Check tag filter
        if (options.tags) {
            // Pass parentDescribes to include all tags from the hierarchy
            const parentDescribeOptions = parentDescribes?.map(pd => pd.options);
            const resolvedTags = this.adoResolver.resolveADOTags(test.options, describe.options, parentDescribeOptions);
            const allTags = this.adoResolver.getAllTags(resolvedTags);
            if (!this.adoResolver.matchesTagFilter(allTags, options.tags)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Ensure browser manager is initialized
     */
    private async ensureBrowserManager(): Promise<void> {
        if (!this.browserManager) {
            if (!CSBrowserManager) {
                CSBrowserManager = require('../browser/CSBrowserManager').CSBrowserManager;
            }
            this.browserManager = CSBrowserManager.getInstance();
        }
    }

    /**
     * Initialize ADO integration
     */
    private async initializeADO(
        options: SpecRunnerOptions,
        collectedTests?: Array<{
            test: RegisteredTest;
            describe: RegisteredDescribe;
            parentDescribes: RegisteredDescribe[];
            specFilePath: string;
        }>
    ): Promise<void> {
        const adoEnabled = this.config.getBoolean('ADO_ENABLED', false) ||
                          this.config.getBoolean('ADO_INTEGRATION_ENABLED', false);
        if (!adoEnabled) {
            return;
        }

        if (!CSADOIntegration) {
            CSADOIntegration = require('../ado/CSADOIntegration').CSADOIntegration;
        }

        this.adoIntegration = CSADOIntegration.getInstance();
        await this.adoIntegration.initialize(options.parallel ? true : false);

        // Collect scenarios for ADO test point mapping (like BDD runner does)
        if (collectedTests && collectedTests.length > 0) {
            const scenarios = this.convertTestsToScenarios(collectedTests);
            CSReporter.debug(`[SpecRunner] Collecting ${scenarios.length} scenarios for ADO`);
            await this.adoIntegration.collectScenarios(scenarios);
        }

        // Start ADO test run with collected test points
        await this.adoIntegration.beforeAllTests();

        CSReporter.info('[SpecRunner] ADO integration initialized');
    }

    /**
     * Report test result to ADO
     */
    private async reportToADO(
        result: SpecTestResult,
        test: RegisteredTest,
        describe: RegisteredDescribe,
        parentDescribes: RegisteredDescribe[]
    ): Promise<void> {
        if (!this.adoIntegration) {
            return;
        }

        try {
            // ADO Tag Priority: Test level > Describe level > Config level
            // Extract TEST-level tags for scenario (highest priority)
            const testTags: string[] = [];
            if (test.options.tags) {
                const tags = Array.isArray(test.options.tags) ? test.options.tags : [test.options.tags];
                testTags.push(...tags.map(t => t.startsWith('@') ? t : `@${t}`));
            }

            // Extract DESCRIBE-level tags for feature (fallback)
            // Order matters: ADOTagExtractor takes FIRST match, so highest priority first
            const featureTags: string[] = [];

            // Add immediate describe tags FIRST (highest priority)
            if (describe.options.tags) {
                const tags = Array.isArray(describe.options.tags) ? describe.options.tags : [describe.options.tags];
                featureTags.push(...tags.map(t => t.startsWith('@') ? t : `@${t}`));
            }

            // Add parent describe tags in reverse order (innermost to outermost)
            for (let i = parentDescribes.length - 1; i >= 0; i--) {
                const pd = parentDescribes[i];
                if (pd.options.tags) {
                    const tags = Array.isArray(pd.options.tags) ? pd.options.tags : [pd.options.tags];
                    featureTags.push(...tags.map(t => t.startsWith('@') ? t : `@${t}`));
                }
            }

            // Create scenario object - ONLY test-level tags
            // IMPORTANT: For data-driven tests, use the original test name (with placeholders)
            // as the scenario name so all iterations are grouped together with the same key
            const scenarioName = result.iteration ? test.name : result.name;
            const scenario = {
                name: scenarioName,
                tags: testTags
            };

            // Create feature object - describe-level tags as FALLBACK
            const feature = {
                name: result.describeName,
                tags: featureTags
            };

            await this.adoIntegration.afterScenario(
                scenario,
                feature,
                result.status,
                result.duration,
                result.error,
                result.screenshots[0],
                result.stack,
                result.iteration?.current,
                result.iteration?.data
            );
        } catch (error: any) {
            CSReporter.debug(`[SpecRunner] ADO reporting error: ${error.message}`);
        }
    }

    /**
     * Complete ADO integration
     */
    private async completeADO(suiteResult: SpecSuiteResult): Promise<void> {
        if (!this.adoIntegration) {
            return;
        }

        try {
            await this.adoIntegration.afterAllTests();
        } catch (error: any) {
            CSReporter.debug(`[SpecRunner] ADO completion error: ${error.message}`);
        }
    }

    /**
     * Capture failure screenshot
     * Returns { fullPath, filename } for proper artifact handling
     * - fullPath: stored in test result screenshots array for artifact collection
     * - filename: stored in step.screenshot for HTML report relative paths
     */
    private async captureFailureScreenshot(testName: string): Promise<{ fullPath: string; filename: string } | null> {
        try {
            const page = this.browserManager?.getPage?.();
            if (!page || page.isClosed()) {
                return null;
            }

            const dirs = this.resultsManager.getDirectories();
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const sanitizedName = testName.replace(/[^a-zA-Z0-9]/g, '-').replace(/-{2,}/g, '-').substring(0, 80);
            const filename = `${sanitizedName}-${timestamp}.png`;
            const fullPath = path.join(dirs.screenshots, filename);

            await page.screenshot({ path: fullPath, fullPage: false });
            CSReporter.info(`Step failure screenshot: ${fullPath}`);

            return { fullPath, filename };
        } catch (error: any) {
            CSReporter.debug(`Failed to capture failure screenshot: ${error.message}`);
            return null;
        }
    }

    /**
     * Generate reports
     */
    private async generateReports(suiteResult: SpecSuiteResult, options: SpecRunnerOptions): Promise<void> {
        // Lazy load report generator
        if (!CSHtmlReportGenerator) {
            CSHtmlReportGenerator = require('../reporter/CSHtmlReportGeneration').CSHtmlReportGenerator;
        }

        const dirs = this.resultsManager.getDirectories();

        // Convert to format expected by report generator
        const worldClassSuite = this.convertToReportFormat(suiteResult);

        // Generate HTML report
        await CSHtmlReportGenerator.generateReport(worldClassSuite, dirs.reports);

        CSReporter.info(`[SpecRunner] Reports generated at: ${dirs.reports}`);
    }

    /**
     * Convert suite result to report format
     * Screenshot paths: step.screenshot contains just filename (like BDD runner)
     * The HTML report generator constructs relative paths as ../screenshots/filename
     */
    private convertToReportFormat(suiteResult: SpecSuiteResult): any {
        const scenarios: any[] = [];

        // Helper to construct relative path for step screenshots
        // Step screenshots now contain just the filename (like BDD runner)
        const toStepScreenshotPath = (screenshotFilename: string | undefined): string | undefined => {
            if (!screenshotFilename) return undefined;
            // If it's already a relative path or full path, extract filename
            const filename = path.basename(screenshotFilename);
            // Return relative path from reports/ to screenshots/
            return `../screenshots/${filename}`;
        };

        // Recursive step converter that preserves children hierarchy
        const convertStep = (step: SpecStepResult, testStack?: string): any => {
            // Skip "Test Actions" fallback step if there are real steps
            if (step.name === 'Test Actions' && (!step.actions || step.actions.length === 0)) {
                return null;
            }
            return {
                name: step.name,
                status: step.status,
                duration: step.duration,
                error: step.error ? { message: step.error, stack: testStack } : undefined,
                screenshot: toStepScreenshotPath(step.screenshot),
                actions: step.actions?.map(action => ({
                    name: action.name,
                    status: action.status,
                    duration: action.duration,
                    element: action.element,
                    screenshot: toStepScreenshotPath(action.screenshot)
                })) || [],
                logs: step.logs || [],
                // Recursively convert children for hierarchical display
                children: step.children?.map(child => convertStep(child, testStack)).filter(Boolean) || [],
                depth: step.depth || 0,
                isHook: step.isHook,
                hookType: step.hookType
            };
        };

        const processDescribe = (describe: SpecDescribeResult) => {
            for (const test of describe.tests) {
                // Convert tracked steps to report format, filtering out empty "Test Actions" and hooks
                let steps: any[] = [];
                if (test.steps && test.steps.length > 0) {
                    steps = test.steps
                        // Filter out hook steps - they're rendered separately in hooks section
                        .filter(step => !step.isHook && !step.hookType)
                        .map(step => convertStep(step, test.stack))
                        .filter(Boolean)
                        // Filter out "Test Actions" if it only has actions that are already in other steps
                        .filter(step => step.name !== 'Test Actions' || step.actions.length > 0);
                }

                // If no steps after filtering, use test name as fallback
                if (steps.length === 0) {
                    steps = [{
                        name: test.name,
                        status: test.status,
                        duration: test.duration,
                        error: test.error ? { message: test.error, stack: test.stack } : undefined,
                        screenshot: test.screenshots[0] ? toStepScreenshotPath(test.screenshots[0]) : undefined,
                        actions: [],
                        logs: [],
                        children: []
                    }];
                }

                // Helper to convert hook steps - reuse convertStep for consistency
                const convertHookSteps = (hookSteps: SpecStepResult[] | undefined) => {
                    if (!hookSteps || hookSteps.length === 0) return undefined;
                    return hookSteps.map(step => convertStep(step, test.stack)).filter(Boolean);
                };

                scenarios.push({
                    name: test.name,
                    status: test.status,
                    feature: describe.name,  // describe name becomes "feature" for grouping
                    tags: test.tags,
                    duration: test.duration,
                    startTime: test.startTime,
                    endTime: test.endTime,
                    workerId: test.workerId ? parseInt(test.workerId) : 1,  // Add workerId for timeline
                    steps,
                    // Flag to distinguish spec runner scenarios from BDD scenarios
                    isSpecRunner: true,
                    // Hook steps - displayed inline with test steps in report
                    beforeAllSteps: convertHookSteps(test.beforeAllSteps),
                    afterAllSteps: convertHookSteps(test.afterAllSteps),
                    beforeEachSteps: convertHookSteps(test.beforeEachSteps),
                    afterEachSteps: convertHookSteps(test.afterEachSteps),
                    testData: test.iteration ? {
                        headers: Object.keys(test.iteration.data),
                        values: Object.values(test.iteration.data).map(String),
                        iterationNumber: test.iteration.current,
                        totalIterations: test.iteration.total,
                        // Add totalColumns and usedColumns for report display
                        totalColumns: Object.keys(test.iteration.data).length,
                        usedColumns: (test.iteration as any).usedColumns || [],  // Tracked columns accessed during test
                        // Data source metadata for display
                        source: test.iteration.source
                    } : undefined,
                    // Attachments and annotations from test.info()
                    attachments: test.attachments,
                    customAnnotations: test.customAnnotations,
                    // Artifacts - full paths for artifact collection (HTML report generator handles display)
                    artifacts: {
                        screenshots: test.screenshots || [],
                        videos: test.video ? [test.video] : [],
                        har: test.har ? [test.har] : [],
                        traces: test.trace ? [test.trace] : []
                    }
                });
            }

            for (const nested of describe.describes) {
                processDescribe(nested);
            }
        };

        for (const describe of suiteResult.describes) {
            processDescribe(describe);
        }

        return {
            name: suiteResult.name,
            scenarios,
            totalScenarios: suiteResult.totalTests,
            passedScenarios: suiteResult.passedTests,
            failedScenarios: suiteResult.failedTests,
            skippedScenarios: suiteResult.skippedTests,
            duration: suiteResult.duration,
            startTime: suiteResult.startTime,
            endTime: suiteResult.endTime,
            // Parallel execution metadata
            parallel: (suiteResult as any).parallel || false,
            workers: (suiteResult as any).workers || 1,
            // Mark as spec format for conditional report rendering
            testFormat: 'spec'
        };
    }

    /**
     * Save final artifacts (HAR, video) before report generation
     * This ensures HAR files are available for collectArtifacts()
     */
    private async saveFinalArtifacts(): Promise<void> {
        try {
            if (this.browserManager) {
                const overallStatus = this.hasAnyFailures ? 'failed' : 'passed';
                CSReporter.debug(`[SpecRunner] Saving final artifacts with status: ${overallStatus}`);

                // Close browser which triggers HAR and video save
                await this.browserManager.closeAll?.(overallStatus);

                // Clear browser manager reference so cleanup doesn't try to close again
                this.browserManager = null;
            }
        } catch (error: any) {
            CSReporter.debug(`[SpecRunner] Error saving final artifacts: ${error.message}`);
        }
    }

    /**
     * Cleanup after run
     */
    private async cleanup(): Promise<void> {
        try {
            // Browser already closed in saveFinalArtifacts, just clean up remaining state
            if (this.browserManager) {
                const overallStatus = this.hasAnyFailures ? 'failed' : 'passed';
                CSReporter.debug(`[SpecRunner] Final cleanup with status: ${overallStatus}`);
                await this.browserManager.closeAll?.(overallStatus);
            }
            this.dataIterator.clearCache();
            this.pageInjector.clearInstances();
            // Reset state for next run
            this.testCountForReuse = 0;
            this.hasAnyFailures = false;
        } catch (error: any) {
            CSReporter.debug(`[SpecRunner] Cleanup error: ${error.message}`);
        }
    }

    /**
     * Create empty suite result
     */
    private createEmptySuiteResult(options: SpecRunnerOptions): SpecSuiteResult {
        return {
            name: options.project,
            environment: options.env || this.config.get('ENVIRONMENT', 'unknown'),
            totalTests: 0,
            passedTests: 0,
            failedTests: 0,
            skippedTests: 0,
            duration: 0,
            startTime: new Date(),
            endTime: new Date(),
            describes: []
        };
    }

    /**
     * Detect if test function uses the 'data' fixture parameter
     * Uses function signature analysis to determine if test needs data iterations
     *
     * @param fn - Test function to analyze
     * @returns true if function uses 'data' parameter, false otherwise
     */
    private testUsesDataFixture(fn: Function): boolean {
        try {
            const fnStr = fn.toString();

            // Match destructured parameter patterns:
            // async ({ data }) => ...
            // async ({ data, config }) => ...
            // async function({ data }) { ... }
            // Also handles: { data: myData } (renamed destructuring)

            // Pattern 1: Destructured 'data' in parameter - { data } or { data, ... } or { ..., data }
            const destructuredPattern = /\(\s*\{[^}]*\bdata\b[^}]*\}\s*\)/;

            // Pattern 2: Renamed destructuring - { data: something }
            const renamedPattern = /\(\s*\{[^}]*\bdata\s*:/;

            // Pattern 3: Direct 'data.' usage in function body (less reliable but catches edge cases)
            // Only check if other patterns don't match
            const directUsagePattern = /\bdata\./;

            if (destructuredPattern.test(fnStr) || renamedPattern.test(fnStr)) {
                return true;
            }

            // Check for data. usage in function body (after the parameter section)
            const bodyMatch = fnStr.match(/\)\s*(?:=>|{)/);
            if (bodyMatch) {
                const bodyStart = fnStr.indexOf(bodyMatch[0]) + bodyMatch[0].length;
                const body = fnStr.substring(bodyStart);
                if (directUsagePattern.test(body)) {
                    return true;
                }
            }

            return false;
        } catch (error) {
            // If detection fails, assume data is used (safe default)
            CSReporter.debug(`[SpecRunner] Failed to detect data usage in test function, assuming data is used`);
            return true;
        }
    }

    /**
     * Create failed result for error cases
     */
    private createFailedResult(testName: string, describeName: string, error: string): SpecTestResult {
        return {
            name: testName,
            describeName,
            status: 'failed',
            duration: 0,
            startTime: new Date(),
            endTime: new Date(),
            error,
            steps: [{
                name: testName,
                status: 'failed',
                duration: 0,
                startTime: new Date(),
                endTime: new Date(),
                error
            }],
            screenshots: [],
            tags: []
        };
    }

    /**
     * Aggregate results from describe into suite
     */
    private aggregateResults(suite: SpecSuiteResult, describe: SpecDescribeResult): void {
        const processDescribe = (d: SpecDescribeResult) => {
            for (const test of d.tests) {
                suite.totalTests++;
                if (test.status === 'passed') suite.passedTests++;
                else if (test.status === 'failed') suite.failedTests++;
                else if (test.status === 'skipped') suite.skippedTests++;
            }
            for (const nested of d.describes) {
                processDescribe(nested);
            }
        };
        processDescribe(describe);
    }

    /**
     * Create work items for parallel execution
     */
    private async createParallelWorkItems(specFiles: string[], options: SpecRunnerOptions): Promise<any[]> {
        const workItems: any[] = [];

        for (const specFile of specFiles) {
            workItems.push({
                type: 'spec',
                filePath: specFile,
                options
            });
        }

        return workItems;
    }

    /**
     * Aggregate parallel execution results
     */
    private aggregateParallelResults(results: any, options: SpecRunnerOptions): SpecSuiteResult {
        const suiteResult = this.createEmptySuiteResult(options);

        // Process results from all workers
        for (const [workId, result] of results.entries()) {
            if (result.describes) {
                suiteResult.describes.push(...result.describes);
                this.aggregateResults(suiteResult, result);
            }
        }

        suiteResult.endTime = new Date();
        return suiteResult;
    }
}
