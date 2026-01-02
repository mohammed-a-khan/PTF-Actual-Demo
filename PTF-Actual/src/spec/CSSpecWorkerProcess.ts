#!/usr/bin/env node
/**
 * Worker Process for Spec Format Parallel Execution
 * Each worker is a separate Node.js process with its own browser instance
 * Based on BDD worker-process.ts pattern
 */

// Register ts-node before any other imports if needed
if (process.env.TS_NODE_TRANSPILE_ONLY === 'true') {
    try {
        require('ts-node').register({
            transpileOnly: true,
            compilerOptions: {
                module: 'commonjs',
                target: 'es2017',
                esModuleInterop: true,
                skipLibCheck: true,
                experimentalDecorators: true,
                emitDecoratorMetadata: true
            }
        });
    } catch (e) {
        // ts-node already registered
    }
}

import * as path from 'path';
import * as fs from 'fs';
import { SpecRuntimeTestState, SpecTestStatus } from './CSSpecTypes';

// Module cache for performance
const moduleCache: Map<string, any> = new Map();

/**
 * Spec Worker Process
 */
class SpecWorkerProcess {
    private workerId: number;
    private browserManager: any = null;
    private configManager: any = null;
    private pageInjector: any = null;
    private adoResolver: any = null;
    private dataIterator: any = null;
    private isInitialized: boolean = false;
    private testCountForReuse: number = 0;
    private anyTestFailed: boolean = false;
    private usedDataColumns: Set<string> = new Set();

    constructor() {
        this.workerId = parseInt(process.env.WORKER_ID || '0');
        process.env.IS_WORKER = 'true';
        process.env.WORKER_ID = String(this.workerId);

        this.setupProcessHandlers();
        this.sendReady();

        // Preload modules in background
        setImmediate(() => this.preloadModules());
    }

    private sendReady(): void {
        setImmediate(() => {
            this.sendMessage({ type: 'ready', workerId: this.workerId });
        });
    }

    private async preloadModules(): Promise<void> {
        try {
            // Preload critical modules
            this.getModule('../core/CSConfigurationManager');
            this.getModule('../browser/CSBrowserManager');
            await this.lazyInitialize();
        } catch (e: any) {
            console.debug(`[Worker ${this.workerId}] Preload warning: ${e.message}`);
        }
    }

    private getModule(moduleName: string): any {
        if (!moduleCache.has(moduleName)) {
            moduleCache.set(moduleName, require(moduleName));
        }
        return moduleCache.get(moduleName);
    }

    private async lazyInitialize(): Promise<void> {
        if (this.isInitialized) return;

        try {
            const { CSConfigurationManager } = this.getModule('../core/CSConfigurationManager');
            this.configManager = CSConfigurationManager.getInstance();

            // Initialize configuration
            const project = process.env.PROJECT || 'common';
            await this.configManager.initialize({ project });

            // Initialize spec-specific modules
            const { CSSpecADOResolver } = this.getModule('./CSSpecADOResolver');
            const { CSSpecDataIterator } = this.getModule('./CSSpecDataIterator');
            const { CSSpecPageInjector } = this.getModule('./CSSpecPageInjector');

            this.adoResolver = CSSpecADOResolver.getInstance();
            this.dataIterator = CSSpecDataIterator.getInstance();
            this.pageInjector = CSSpecPageInjector.getInstance();

            // Scan for page objects
            await this.pageInjector.scanPages();

            this.isInitialized = true;
            console.log(`[Worker ${this.workerId}] Initialized successfully`);
        } catch (error: any) {
            console.error(`[Worker ${this.workerId}] Failed to initialize: ${error.message}`);
            throw error;
        }
    }

    private async initializeBrowser(): Promise<void> {
        const browserLaunchRequired = this.configManager.getBoolean('BROWSER_LAUNCH_REQUIRED', true);
        if (!browserLaunchRequired) {
            console.log(`[Worker ${this.workerId}] Browser launch disabled`);
            return;
        }

        try {
            const { CSBrowserManager } = this.getModule('../browser/CSBrowserManager');
            this.browserManager = CSBrowserManager.getInstance();

            // Always ensure browser is launched
            const isLaunched = this.browserManager.isLaunched?.() || this.browserManager.browser;
            if (!isLaunched) {
                console.log(`[Worker ${this.workerId}] Launching browser...`);
                await this.browserManager.launch();
                console.log(`[Worker ${this.workerId}] Browser launched`);
            }
        } catch (error: any) {
            console.error(`[Worker ${this.workerId}] Failed to initialize browser: ${error.message}`);
            throw error;
        }
    }

    private setupProcessHandlers(): void {
        process.on('message', this.handleMessage.bind(this));
        process.on('SIGTERM', this.cleanup.bind(this));
        process.on('SIGINT', this.cleanup.bind(this));
        process.on('uncaughtException', (error) => {
            console.error(`[Worker ${this.workerId}] Uncaught exception:`, error);
            this.cleanup();
        });
    }

    private async handleMessage(message: any): Promise<void> {
        switch (message.type) {
            case 'execute':
                await this.executeTest(message);
                break;
            case 'execute-batch':
                await this.executeSerialBatch(message);
                break;
            case 'terminate':
                await this.cleanup();
                process.exit(0);
                break;
        }
    }

    /**
     * Execute a serial batch of tests
     * If one test fails, remaining tests are skipped
     */
    private async executeSerialBatch(message: any): Promise<void> {
        const results: any[] = [];
        let batchFailed = false;

        console.log(`[Worker ${this.workerId}] Executing serial batch: ${message.describeName} (${message.tests.length} tests)`);

        // Initialize browser once for the entire batch
        let batchFixtures: any = null;
        let targetDescribe: any = null;
        let parentDescribes: any[] = [];

        try {
            await this.lazyInitialize();
            if (message.testResultsDir) {
                process.env.TEST_RESULTS_DIR = message.testResultsDir;
                this.configManager.set('TEST_RESULTS_DIR', message.testResultsDir);
            }
            await this.initializeBrowser();

            // Load spec file and find the describe to get beforeAll/afterAll hooks
            const specFilePath = require.resolve(message.specFilePath);
            delete require.cache[specFilePath];

            const { CSSpecDescribe } = this.getModule('./CSSpecDescribe');
            const registry = CSSpecDescribe.getInstance();
            registry.clear();

            require(message.specFilePath);
            const describes = registry.getRegisteredDescribes();

            // Find the target describe
            const findDescribe = (describe: any, parents: any[] = []): boolean => {
                if (describe.name === message.describeName) {
                    targetDescribe = describe;
                    parentDescribes = [...parents];
                    return true;
                }
                for (const nested of describe.describes) {
                    if (findDescribe(nested, [...parents, describe])) {
                        return true;
                    }
                }
                return false;
            };

            for (const describe of describes) {
                if (findDescribe(describe)) break;
            }

            if (targetDescribe) {
                // Create step tracker and fixtures for beforeAll hooks
                const { createStepTracker, hookElementActions, hookReporterActions } = this.getModule('./CSSpecStepTracker');
                hookElementActions();
                hookReporterActions();
                const batchStepTracker = createStepTracker();
                batchStepTracker.setHookType('beforeAll'); // Mark steps as hook steps

                batchFixtures = await this.createFixtures({}, null, batchStepTracker, true);

                // Execute beforeAll hooks from parent describes (outermost to innermost)
                // Track each hook as a step with isHook: true
                console.log(`[Worker ${this.workerId}] Executing beforeAll hooks for batch: ${message.describeName}`);
                for (const pd of parentDescribes) {
                    if (pd.beforeAll && pd.beforeAll.length > 0) {
                        console.log(`[Worker ${this.workerId}] Running ${pd.beforeAll.length} beforeAll hook(s) from parent: ${pd.name}`);
                        for (let i = 0; i < pd.beforeAll.length; i++) {
                            const hook = pd.beforeAll[i];
                            const hookTitle = (hook as any).title || `beforeAll (${pd.name})`;
                            batchStepTracker.step(hookTitle);
                            try {
                                await hook(batchFixtures);
                                batchStepTracker.endStep();
                            } catch (hookError: any) {
                                batchStepTracker.failStep(hookError.message);
                                throw hookError;
                            }
                        }
                    }
                }

                // Execute target describe's beforeAll hooks
                if (targetDescribe.beforeAll && targetDescribe.beforeAll.length > 0) {
                    console.log(`[Worker ${this.workerId}] Running ${targetDescribe.beforeAll.length} beforeAll hook(s) from: ${targetDescribe.name}`);
                    for (let i = 0; i < targetDescribe.beforeAll.length; i++) {
                        const hook = targetDescribe.beforeAll[i];
                        const hookTitle = (hook as any).title || `beforeAll (${targetDescribe.name})`;
                        batchStepTracker.step(hookTitle);
                        try {
                            await hook(batchFixtures);
                            batchStepTracker.endStep();
                        } catch (hookError: any) {
                            batchStepTracker.failStep(hookError.message);
                            throw hookError;
                        }
                    }
                }

                // Store beforeAll steps to add to first test result
                (message as any)._beforeAllSteps = batchStepTracker.finalize();
            }
        } catch (error: any) {
            console.error(`[Worker ${this.workerId}] Failed to initialize for batch: ${error.message}`);
            // Return failed results for all tests
            for (const test of message.tests) {
                results.push({
                    type: 'result',
                    name: test.testName,
                    describeName: message.describeName,
                    status: 'failed',
                    duration: 0,
                    error: `Batch initialization failed: ${error.message}`,
                    startTime: new Date(),
                    endTime: new Date(),
                    steps: [],
                    screenshots: [],
                    tags: []
                });
            }
            this.sendMessage({ type: 'batch-result', workId: message.workId, results });
            return;
        }

        // Execute each test in the batch sequentially
        let isFirstTest = true;
        for (const test of message.tests) {
            if (batchFailed) {
                // Skip remaining tests due to prior failure
                console.log(`[Worker ${this.workerId}] ⊘ Skipping ${test.testName} (serial dependency)`);
                results.push({
                    type: 'result',
                    name: test.iterationNumber
                        ? `${test.testName} [Iteration ${test.iterationNumber}/${test.totalIterations}]`
                        : test.testName,
                    originalTestName: test.testName,
                    describeName: message.describeName,
                    status: 'skipped',
                    duration: 0,
                    skipReason: 'Skipped due to prior test failure in serial mode',
                    startTime: new Date(),
                    endTime: new Date(),
                    steps: [],
                    screenshots: [],
                    tags: [],
                    iteration: test.iterationNumber ? {
                        current: test.iterationNumber,
                        total: test.totalIterations,
                        data: test.dataRow
                    } : undefined
                });
                continue;
            }

            // Execute the test - only clear context on first test of batch
            // Pass beforeAll steps to first test so they appear in the report
            const result = await this.executeSingleTestInBatch({
                testName: test.testName,
                describeName: message.describeName,
                specFilePath: message.specFilePath,
                options: message.options,
                iterationNumber: test.iterationNumber,
                totalIterations: test.totalIterations,
                beforeAllSteps: isFirstTest ? (message as any)._beforeAllSteps : undefined,
                dataRow: test.dataRow,
                isFirstTestInBatch: isFirstTest
            });
            isFirstTest = false;

            results.push(result);

            // Check if test failed (mark batch as failed)
            if (result.status === 'failed' || result.status === 'unexpected-pass') {
                batchFailed = true;
                console.log(`[Worker ${this.workerId}] Serial batch marked as failed after: ${test.testName}`);
            }
        }

        // Execute afterAll hooks (innermost to outermost - reverse order)
        // Track afterAll steps to append to last test result
        if (targetDescribe && batchFixtures) {
            const { createStepTracker } = this.getModule('./CSSpecStepTracker');
            const afterAllStepTracker = createStepTracker();
            afterAllStepTracker.setHookType('afterAll');

            try {
                console.log(`[Worker ${this.workerId}] Executing afterAll hooks for batch: ${message.describeName}`);
                if (targetDescribe.afterAll && targetDescribe.afterAll.length > 0) {
                    console.log(`[Worker ${this.workerId}] Running ${targetDescribe.afterAll.length} afterAll hook(s) from: ${targetDescribe.name}`);
                    for (let i = 0; i < targetDescribe.afterAll.length; i++) {
                        const hook = targetDescribe.afterAll[i];
                        const hookTitle = (hook as any).title || `afterAll (${targetDescribe.name})`;
                        afterAllStepTracker.step(hookTitle);
                        try {
                            await hook(batchFixtures);
                            afterAllStepTracker.endStep();
                        } catch (hookError: any) {
                            afterAllStepTracker.failStep(hookError.message);
                            // Don't throw - continue with other hooks
                        }
                    }
                }
                for (let i = parentDescribes.length - 1; i >= 0; i--) {
                    const pd = parentDescribes[i];
                    if (pd.afterAll && pd.afterAll.length > 0) {
                        console.log(`[Worker ${this.workerId}] Running ${pd.afterAll.length} afterAll hook(s) from parent: ${pd.name}`);
                        for (let j = 0; j < pd.afterAll.length; j++) {
                            const hook = pd.afterAll[j];
                            const hookTitle = (hook as any).title || `afterAll (${pd.name})`;
                            afterAllStepTracker.step(hookTitle);
                            try {
                                await hook(batchFixtures);
                                afterAllStepTracker.endStep();
                            } catch (hookError: any) {
                                afterAllStepTracker.failStep(hookError.message);
                                // Don't throw - continue with other hooks
                            }
                        }
                    }
                }

                // Append afterAll steps to the last test result
                const afterAllSteps = afterAllStepTracker.finalize();
                if (afterAllSteps.length > 0 && results.length > 0) {
                    const lastResult = results[results.length - 1];
                    lastResult.steps = [...(lastResult.steps || []), ...afterAllSteps];
                }
            } catch (hookError: any) {
                console.error(`[Worker ${this.workerId}] afterAll hook failed: ${hookError.message}`);
            }
        }

        // Handle browser cleanup BEFORE sending results to prevent race condition
        // where new work is assigned before cleanup completes
        await this.handleBrowserCleanup(batchFailed ? 'failed' : 'passed');

        // Send all results back (after cleanup is complete)
        this.sendMessage({ type: 'batch-result', workId: message.workId, results });
    }

    /**
     * Execute a single test within a serial batch (no cleanup between tests)
     */
    private async executeSingleTestInBatch(message: any): Promise<any> {
        const startTime = Date.now();

        // Calculate interpolated test name early for use in screenshots and logging
        const interpolatedTestName = message.dataRow
            ? this.interpolateTestName(message.testName, message.dataRow)
            : message.testName;
        const displayName = message.iterationNumber
            ? `${interpolatedTestName} [Iteration ${message.iterationNumber}/${message.totalIterations}]`
            : interpolatedTestName;

        const result: any = {
            type: 'result',
            name: displayName,
            originalTestName: message.testName,
            describeName: message.describeName,
            status: 'failed',
            duration: 0,
            steps: [],
            screenshots: [],
            tags: [],
            startTime: new Date()
        };

        let stepTracker: any = null;
        let runtimeState: SpecRuntimeTestState | null = null;

        try {
            // Load spec file and find the test
            const specFilePath = require.resolve(message.specFilePath);
            delete require.cache[specFilePath];

            const { CSSpecDescribe, setCurrentTestState, setCurrentTestInfo } = this.getModule('./CSSpecDescribe');
            const { createTestInfo, createRuntimeState } = this.getModule('./CSSpecTestInfo');
            const registry = CSSpecDescribe.getInstance();
            registry.clear();

            require(message.specFilePath);
            const describes = registry.getRegisteredDescribes();

            // Find the specific test
            let targetTest: any = null;
            let targetDescribe: any = null;
            let parentDescribes: any[] = [];

            const findTest = (describe: any, parents: any[] = []): boolean => {
                for (const test of describe.tests) {
                    if (test.name === message.testName) {
                        targetTest = test;
                        targetDescribe = describe;
                        parentDescribes = [...parents];
                        return true;
                    }
                }
                for (const nested of describe.describes) {
                    if (findTest(nested, [...parents, describe])) {
                        return true;
                    }
                }
                return false;
            };

            for (const describe of describes) {
                if (findTest(describe)) break;
            }

            if (!targetTest || !targetDescribe) {
                throw new Error(`Test "${message.testName}" not found`);
            }

            // Check decorator-level skip/fixme
            if (targetTest.options.skip) {
                result.status = 'skipped';
                result.skipReason = typeof targetTest.options.skip === 'string' ? targetTest.options.skip : 'Skipped';
                result.endTime = new Date();
                result.duration = Date.now() - startTime;
                return result;
            }

            if (targetTest.options.fixme) {
                result.status = 'fixme';
                result.skipReason = typeof targetTest.options.fixme === 'string' ? targetTest.options.fixme : 'Marked as fixme';
                result.endTime = new Date();
                result.duration = Date.now() - startTime;
                return result;
            }

            // Create runtime state
            runtimeState = createRuntimeState();

            // Check decorator-level expectedToFail and slow
            if (targetTest.options.expectedToFail) {
                runtimeState!.expectedToFail = true;
                runtimeState!.expectedFailReason = typeof targetTest.options.expectedToFail === 'string'
                    ? targetTest.options.expectedToFail : 'Expected to fail';
            }
            if (targetTest.options.slow) {
                runtimeState!.isSlow = true;
                runtimeState!.slowReason = typeof targetTest.options.slow === 'string' ? targetTest.options.slow : 'Marked as slow';
            }

            // Calculate timeout
            let timeout = targetTest.options.timeout || targetDescribe.options.timeout || message.options?.timeout || 30000;
            if (runtimeState!.isSlow) {
                timeout *= 3;
            }

            // Create test info
            const dirs = { base: message.testResultsDir || 'reports', screenshots: path.join(message.testResultsDir || 'reports', 'screenshots') };
            const testInfo = createTestInfo({
                title: targetTest.name,
                titlePath: [...parentDescribes.map((d: any) => d.name), targetDescribe.name, targetTest.name],
                file: message.specFilePath,
                retry: 0,
                parallelIndex: this.workerId,
                project: message.options?.project || 'default',
                timeout,
                outputDir: dirs.base,
                snapshotDir: dirs.screenshots,
                runtimeState: runtimeState!
            });

            // Set global state
            setCurrentTestState(runtimeState!);
            setCurrentTestInfo(testInfo);

            // Create step tracker
            const { createStepTracker, setCurrentStepTracker, hookElementActions, hookReporterActions } = this.getModule('./CSSpecStepTracker');
            hookElementActions();
            hookReporterActions();
            stepTracker = createStepTracker();

            // Create fixtures - NEVER clear context in serial batch tests
            // beforeAll already ran and may have set context values that need to persist
            const clearContext = false;
            const fixtures = await this.createFixtures(message.dataRow || {}, message.iterationNumber && message.totalIterations ? {
                current: message.iterationNumber,
                total: message.totalIterations,
                data: message.dataRow || {}
            } : null, stepTracker, clearContext);

            // Execute beforeEach hooks with step tracking
            const beforeEachStepTracker = createStepTracker();
            beforeEachStepTracker.setHookType('beforeEach');
            setCurrentStepTracker(beforeEachStepTracker);

            for (const pd of parentDescribes) {
                if (pd.beforeEach?.length > 0) {
                    await beforeEachStepTracker.step(pd.name);
                    for (const hook of pd.beforeEach) await hook(fixtures);
                    beforeEachStepTracker.endStep();
                }
            }
            if (targetDescribe.beforeEach?.length > 0) {
                await beforeEachStepTracker.step(targetDescribe.name);
                for (const hook of targetDescribe.beforeEach) await hook(fixtures);
                beforeEachStepTracker.endStep();
            }

            result.beforeEachSteps = beforeEachStepTracker.finalize();
            setCurrentStepTracker(stepTracker);

            // Check runtime skip/fixme before execution
            if (runtimeState!.shouldSkip) {
                result.status = 'skipped';
                result.skipReason = runtimeState!.skipReason;
                throw new Error(`SKIP: ${result.skipReason}`);
            }
            if (runtimeState!.isFixme) {
                result.status = 'fixme';
                result.skipReason = runtimeState!.fixmeReason;
                throw new Error(`FIXME: ${result.skipReason}`);
            }

            // Get effective timeout
            const effectiveTimeout = runtimeState!.customTimeout ?? timeout;

            // Execute test
            let testPassed = false;
            try {
                await Promise.race([
                    targetTest.fn(fixtures),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`Test timeout exceeded (${effectiveTimeout}ms)`)), effectiveTimeout))
                ]);
                testPassed = true;
            } catch (testError: any) {
                // Handle runtime skip/fixme thrown by test.skip() or test.fixme()
                if (testError.message.startsWith('SKIP:')) {
                    result.status = 'skipped';
                    result.skipReason = runtimeState!.skipReason || testError.message.replace('SKIP: ', '');
                    console.log(`[Worker ${this.workerId}] ⊘ Skipped: ${displayName} - ${result.skipReason}`);
                } else if (testError.message.startsWith('FIXME:')) {
                    result.status = 'fixme';
                    result.skipReason = runtimeState!.fixmeReason || testError.message.replace('FIXME: ', '');
                    console.log(`[Worker ${this.workerId}] ⚠ Fixme: ${displayName} - ${result.skipReason}`);
                } else {
                    throw testError;
                }
            }

            // Execute afterEach hooks with step tracking
            const afterEachStepTracker = createStepTracker();
            afterEachStepTracker.setHookType('afterEach');
            setCurrentStepTracker(afterEachStepTracker);

            if (targetDescribe.afterEach?.length > 0) {
                await afterEachStepTracker.step(targetDescribe.name);
                for (const hook of targetDescribe.afterEach) await hook(fixtures);
                afterEachStepTracker.endStep();
            }
            for (let i = parentDescribes.length - 1; i >= 0; i--) {
                const pd = parentDescribes[i];
                if (pd.afterEach?.length > 0) {
                    await afterEachStepTracker.step(pd.name);
                    for (const hook of pd.afterEach) await hook(fixtures);
                    afterEachStepTracker.endStep();
                }
            }

            result.afterEachSteps = afterEachStepTracker.finalize();
            setCurrentStepTracker(null);

            // Determine final status
            if (result.status === 'skipped' || result.status === 'fixme') {
                // Already set
            } else if (runtimeState!.expectedToFail) {
                if (testPassed) {
                    result.status = 'unexpected-pass';
                    result.error = `Test was expected to fail but passed. Reason: ${runtimeState!.expectedFailReason}`;
                } else {
                    result.status = 'expected-failure';
                    result.skipReason = runtimeState!.expectedFailReason;
                }
            } else if (testPassed) {
                result.status = 'passed';
            }

            // Capture custom annotations and attachments from test.info()
            if (runtimeState!.annotations && runtimeState!.annotations.length > 0) {
                result.customAnnotations = runtimeState!.annotations;
            }
            if (runtimeState!.attachments && runtimeState!.attachments.length > 0) {
                result.attachments = runtimeState!.attachments;
            }

            // Clean up global state
            setCurrentTestState(null);
            setCurrentTestInfo(null);

            // Resolve tags
            const resolvedTags = this.adoResolver.resolveADOTags(targetTest.options, targetDescribe.options, parentDescribes.map((d: any) => d.options));
            result.tags = this.adoResolver.getAllTags(resolvedTags);

        } catch (error: any) {
            if (error.message.startsWith('SKIP:') || error.message.startsWith('FIXME:')) {
                // Already handled
            } else {
                console.error(`[Worker ${this.workerId}] ✗ Test failed: ${displayName} - ${error.message}`);
                result.status = 'failed';
                result.error = error.message;
                result.stackTrace = error.stack;
                this.anyTestFailed = true;

                // Capture screenshot with interpolated name
                try {
                    const screenshotPath = await this.captureFailureScreenshot(displayName);
                    if (screenshotPath) {
                        result.screenshots.push(screenshotPath);
                        if (stepTracker) stepTracker.screenshot(path.basename(screenshotPath));
                    }
                } catch (e) {}

                if (stepTracker) stepTracker.failStep(error.message);
            }

            // Capture custom annotations and attachments from test.info() (even on failure/skip)
            if (runtimeState) {
                if (runtimeState.annotations && runtimeState.annotations.length > 0) {
                    result.customAnnotations = runtimeState.annotations;
                }
                if (runtimeState.attachments && runtimeState.attachments.length > 0) {
                    result.attachments = runtimeState.attachments;
                }
            }
        } finally {
            if (stepTracker) result.steps = stepTracker.finalize();
        }

        // Prepend beforeAll steps if this is the first test in batch
        if (message.beforeAllSteps && message.beforeAllSteps.length > 0) {
            result.steps = [...message.beforeAllSteps, ...result.steps];
        }

        result.duration = Date.now() - startTime;
        result.endTime = new Date();

        // Add iteration info (name was already set at start with interpolation)
        if (message.iterationNumber) {
            result.iteration = {
                current: message.iterationNumber,
                total: message.totalIterations,
                data: message.dataRow,
                usedColumns: this.getUsedDataColumns(),
                source: message.dataSource ? this.createSourceInfo(message.dataSource) : undefined
            };
        }

        const statusSymbol = result.status === 'passed' ? '✓' : result.status === 'skipped' ? '⊘' : result.status === 'fixme' ? '⚠' : '✗';
        console.log(`[Worker ${this.workerId}] ${statusSymbol} ${result.name} (${result.duration}ms)`);

        return result;
    }

    /**
     * Execute a single test
     */
    private async executeTest(message: any): Promise<void> {
        const startTime = Date.now();

        // Calculate interpolated test name early for use in screenshots and logging
        const interpolatedTestName = message.dataRow
            ? this.interpolateTestName(message.testName, message.dataRow)
            : message.testName;
        const displayName = message.iterationNumber
            ? `${interpolatedTestName} [Iteration ${message.iterationNumber}/${message.totalIterations}]`
            : interpolatedTestName;

        const result: any = {
            type: 'result',
            workId: message.workId,
            name: displayName,
            describeName: message.describeName,
            status: 'failed',
            duration: 0,
            steps: [],
            screenshots: [],
            tags: [],
            startTime: new Date()
        };

        let stepTracker: any = null;
        let beforeAllSteps: any[] = [];
        let afterAllSteps: any[] = [];
        let beforeEachSteps: any[] = [];
        let afterEachSteps: any[] = [];
        let runtimeState: any = null;
        let setCurrentTestState: any = null;
        let setCurrentTestInfo: any = null;

        try {
            // Initialize if needed
            await this.lazyInitialize();

            // Set test results directory
            if (message.testResultsDir) {
                process.env.TEST_RESULTS_DIR = message.testResultsDir;
                this.configManager.set('TEST_RESULTS_DIR', message.testResultsDir);
            }

            // Initialize browser BEFORE loading spec file
            await this.initializeBrowser();

            // Clear require cache for spec file to ensure fresh registration
            const specFilePath = require.resolve(message.specFilePath);
            delete require.cache[specFilePath];

            // Load spec file and find the test
            const { CSSpecDescribe } = this.getModule('./CSSpecDescribe');
            const registry = CSSpecDescribe.getInstance();
            registry.clear();

            // Load spec file (will re-register all describe/test blocks)
            console.log(`[Worker ${this.workerId}] Loading spec file: ${path.basename(message.specFilePath)}`);
            require(message.specFilePath);
            const describes = registry.getRegisteredDescribes();

            if (describes.length === 0) {
                throw new Error(`No describes found in ${message.specFilePath}`);
            }

            // Find the specific test (handle nested describes)
            let targetTest: any = null;
            let targetDescribe: any = null;
            let parentDescribes: any[] = [];

            const findTest = (describe: any, parents: any[] = []): boolean => {
                // Check tests in this describe
                for (const test of describe.tests) {
                    if (test.name === message.testName) {
                        targetTest = test;
                        targetDescribe = describe;
                        parentDescribes = [...parents];
                        return true;
                    }
                }
                // Check nested describes
                for (const nested of describe.describes) {
                    if (findTest(nested, [...parents, describe])) {
                        return true;
                    }
                }
                return false;
            };

            for (const describe of describes) {
                if (findTest(describe)) break;
            }

            if (!targetTest || !targetDescribe) {
                throw new Error(`Test "${message.testName}" not found in ${message.specFilePath}. Available describes: ${describes.map((d: any) => d.name).join(', ')}`);
            }

            console.log(`[Worker ${this.workerId}] Found test: ${message.testName} in describe: ${targetDescribe.name}`);
            console.log(`[Worker ${this.workerId}] Parent describes: ${parentDescribes.map((d: any) => d.name).join(' > ')}`);

            // Create step tracker
            const { createStepTracker, setCurrentStepTracker, hookElementActions, hookReporterActions } = this.getModule('./CSSpecStepTracker');
            hookElementActions();
            hookReporterActions();
            stepTracker = createStepTracker();

            // Create testInfo and runtimeState for test.info() API support
            const describeModule = this.getModule('./CSSpecDescribe');
            setCurrentTestState = describeModule.setCurrentTestState;
            setCurrentTestInfo = describeModule.setCurrentTestInfo;
            const { createTestInfo, createRuntimeState } = this.getModule('./CSSpecTestInfo');
            runtimeState = createRuntimeState();

            // Calculate timeout
            const timeout = targetTest.options.timeout || targetDescribe.options.timeout || message.options?.timeout || 30000;

            // Create test info
            const testInfo = createTestInfo({
                title: targetTest.name,
                titlePath: [...parentDescribes.map((d: any) => d.name), targetDescribe.name, targetTest.name],
                file: message.specFilePath,
                retry: 0,
                parallelIndex: this.workerId,
                project: message.options?.project || 'default',
                timeout,
                outputDir: message.testResultsDir || 'reports',
                snapshotDir: path.join(message.testResultsDir || 'reports', 'screenshots'),
                runtimeState
            });

            // Set global state for test.info() access
            setCurrentTestState(runtimeState);
            setCurrentTestInfo(testInfo);

            // Create fixtures with proper data
            const fixtures = await this.createFixtures(
                message.dataRow || {},
                message.iterationNumber && message.totalIterations ? {
                    current: message.iterationNumber,
                    total: message.totalIterations,
                    data: message.dataRow || {}
                } : null,
                stepTracker
            );

            // Execute beforeAll hooks from ALL parent describes (outermost to innermost)
            // This is critical for distributed single work items that depend on beforeAll (e.g., login)
            // Track hooks as separate steps with isHook: true
            const beforeAllStepTracker = createStepTracker();
            beforeAllStepTracker.setHookType('beforeAll');

            console.log(`[Worker ${this.workerId}] Executing beforeAll hooks from ${parentDescribes.length} parent describe(s)`);
            for (const parentDescribe of parentDescribes) {
                if (parentDescribe.beforeAll && parentDescribe.beforeAll.length > 0) {
                    console.log(`[Worker ${this.workerId}] Running ${parentDescribe.beforeAll.length} beforeAll hook(s) from: ${parentDescribe.name}`);
                    for (let i = 0; i < parentDescribe.beforeAll.length; i++) {
                        const hook = parentDescribe.beforeAll[i];
                        const hookTitle = (hook as any).title || `beforeAll (${parentDescribe.name})`;
                        beforeAllStepTracker.step(hookTitle);
                        try {
                            await hook(fixtures);
                            beforeAllStepTracker.endStep();
                        } catch (hookError: any) {
                            beforeAllStepTracker.failStep(hookError.message);
                            throw hookError;
                        }
                    }
                }
            }

            // Execute current describe's beforeAll hooks
            if (targetDescribe.beforeAll && targetDescribe.beforeAll.length > 0) {
                console.log(`[Worker ${this.workerId}] Running ${targetDescribe.beforeAll.length} beforeAll hook(s) from: ${targetDescribe.name}`);
                for (let i = 0; i < targetDescribe.beforeAll.length; i++) {
                    const hook = targetDescribe.beforeAll[i];
                    const hookTitle = (hook as any).title || `beforeAll (${targetDescribe.name})`;
                    beforeAllStepTracker.step(hookTitle);
                    try {
                        await hook(fixtures);
                        beforeAllStepTracker.endStep();
                    } catch (hookError: any) {
                        beforeAllStepTracker.failStep(hookError.message);
                        throw hookError;
                    }
                }
            }

            // Store beforeAll steps to prepend to result later
            beforeAllSteps = beforeAllStepTracker.finalize();

            // Execute beforeEach hooks from ALL parent describes (outermost to innermost)
            // Track hooks as separate steps for report display
            const beforeEachStepTracker = createStepTracker();
            beforeEachStepTracker.setHookType('beforeEach');
            setCurrentStepTracker(beforeEachStepTracker);

            console.log(`[Worker ${this.workerId}] Executing beforeEach hooks from ${parentDescribes.length} parent describe(s)`);
            for (const parentDescribe of parentDescribes) {
                if (parentDescribe.beforeEach && parentDescribe.beforeEach.length > 0) {
                    console.log(`[Worker ${this.workerId}] Running ${parentDescribe.beforeEach.length} beforeEach hook(s) from: ${parentDescribe.name}`);
                    await beforeEachStepTracker.step(parentDescribe.name);
                    for (const hook of parentDescribe.beforeEach) {
                        await hook(fixtures);
                    }
                    beforeEachStepTracker.endStep();
                }
            }

            // Execute current describe's beforeEach hooks
            if (targetDescribe.beforeEach && targetDescribe.beforeEach.length > 0) {
                console.log(`[Worker ${this.workerId}] Running ${targetDescribe.beforeEach.length} beforeEach hook(s) from: ${targetDescribe.name}`);
                await beforeEachStepTracker.step(targetDescribe.name);
                for (const hook of targetDescribe.beforeEach) {
                    await hook(fixtures);
                }
                beforeEachStepTracker.endStep();
            }

            // Store beforeEach steps for result
            beforeEachSteps = beforeEachStepTracker.finalize();

            // IMPORTANT: Restore the test's step tracker as current so test actions are captured correctly
            setCurrentStepTracker(stepTracker);

            // Execute test with timeout (timeout already calculated above for testInfo)
            console.log(`[Worker ${this.workerId}] Executing test: ${message.testName} (timeout: ${timeout}ms)`);

            // Execute test with proper try/finally to ensure hooks always run
            let testError: any = null;
            try {
                await Promise.race([
                    targetTest.fn(fixtures),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Test timeout exceeded (${timeout}ms)`)), timeout)
                    )
                ]);
            } catch (error) {
                testError = error;
            }

            // Execute afterEach hooks (innermost to outermost - reverse order) - ALWAYS run
            // Track hooks as separate steps for report display
            const afterEachStepTracker = createStepTracker();
            afterEachStepTracker.setHookType('afterEach');
            setCurrentStepTracker(afterEachStepTracker);

            try {
                if (targetDescribe.afterEach && targetDescribe.afterEach.length > 0) {
                    console.log(`[Worker ${this.workerId}] Running ${targetDescribe.afterEach.length} afterEach hook(s) from: ${targetDescribe.name}`);
                    await afterEachStepTracker.step(targetDescribe.name);
                    for (const hook of targetDescribe.afterEach) {
                        await hook(fixtures);
                    }
                    afterEachStepTracker.endStep();
                }
                for (let i = parentDescribes.length - 1; i >= 0; i--) {
                    const pd = parentDescribes[i];
                    if (pd.afterEach && pd.afterEach.length > 0) {
                        console.log(`[Worker ${this.workerId}] Running ${pd.afterEach.length} afterEach hook(s) from: ${pd.name}`);
                        await afterEachStepTracker.step(pd.name);
                        for (const hook of pd.afterEach) {
                            await hook(fixtures);
                        }
                        afterEachStepTracker.endStep();
                    }
                }
            } catch (hookError: any) {
                console.error(`[Worker ${this.workerId}] afterEach hook failed: ${hookError.message}`);
                afterEachStepTracker.failStep(hookError.message);
                if (!testError) testError = hookError;
            }

            // Store afterEach steps for result
            afterEachSteps = afterEachStepTracker.finalize();

            // Execute afterAll hooks (innermost to outermost - reverse order) - ALWAYS run
            // For distributed single work items, each worker runs afterAll after its test
            // Track hooks as separate steps with isHook: true
            const afterAllStepTracker = createStepTracker();
            afterAllStepTracker.setHookType('afterAll');

            try {
                if (targetDescribe.afterAll && targetDescribe.afterAll.length > 0) {
                    console.log(`[Worker ${this.workerId}] Running ${targetDescribe.afterAll.length} afterAll hook(s) from: ${targetDescribe.name}`);
                    for (let i = 0; i < targetDescribe.afterAll.length; i++) {
                        const hook = targetDescribe.afterAll[i];
                        const hookTitle = (hook as any).title || `afterAll (${targetDescribe.name})`;
                        afterAllStepTracker.step(hookTitle);
                        try {
                            await hook(fixtures);
                            afterAllStepTracker.endStep();
                        } catch (hookError: any) {
                            afterAllStepTracker.failStep(hookError.message);
                            throw hookError;
                        }
                    }
                }
                for (let i = parentDescribes.length - 1; i >= 0; i--) {
                    const pd = parentDescribes[i];
                    if (pd.afterAll && pd.afterAll.length > 0) {
                        console.log(`[Worker ${this.workerId}] Running ${pd.afterAll.length} afterAll hook(s) from: ${pd.name}`);
                        for (let j = 0; j < pd.afterAll.length; j++) {
                            const hook = pd.afterAll[j];
                            const hookTitle = (hook as any).title || `afterAll (${pd.name})`;
                            afterAllStepTracker.step(hookTitle);
                            try {
                                await hook(fixtures);
                                afterAllStepTracker.endStep();
                            } catch (hookError: any) {
                                afterAllStepTracker.failStep(hookError.message);
                                throw hookError;
                            }
                        }
                    }
                }
            } catch (hookError: any) {
                console.error(`[Worker ${this.workerId}] afterAll hook failed: ${hookError.message}`);
                if (!testError) testError = hookError;
            }

            // Store afterAll steps to append to result later
            afterAllSteps = afterAllStepTracker.finalize();

            // Re-throw test error if there was one
            if (testError) {
                throw testError;
            }

            // Test passed
            result.status = 'passed';
            console.log(`[Worker ${this.workerId}] ✓ Test passed: ${displayName}`);

            // Capture custom annotations and attachments from test.info()
            if (runtimeState.annotations && runtimeState.annotations.length > 0) {
                result.customAnnotations = runtimeState.annotations;
            }
            if (runtimeState.attachments && runtimeState.attachments.length > 0) {
                result.attachments = runtimeState.attachments;
            }

            // Clean up global state
            setCurrentTestState(null);
            setCurrentTestInfo(null);

            // Resolve tags
            const resolvedTags = this.adoResolver.resolveADOTags(
                targetTest.options,
                targetDescribe.options,
                parentDescribes.map((d: any) => d.options)
            );
            result.tags = this.adoResolver.getAllTags(resolvedTags);

        } catch (error: any) {
            console.error(`[Worker ${this.workerId}] ✗ Test failed: ${displayName}`);
            console.error(`[Worker ${this.workerId}] Error: ${error.message}`);
            console.error(`[Worker ${this.workerId}] Stack: ${error.stack}`);

            result.status = 'failed';
            result.error = error.message;
            result.stackTrace = error.stack;
            this.anyTestFailed = true;

            // Capture failure screenshot with interpolated name
            let screenshotFilename: string | null = null;
            try {
                const screenshotPath = await this.captureFailureScreenshot(displayName);
                if (screenshotPath) {
                    result.screenshots.push(screenshotPath);
                    // Extract just filename for step tracker (report uses relative paths)
                    screenshotFilename = path.basename(screenshotPath);
                }
            } catch (e) {
                console.debug(`[Worker ${this.workerId}] Failed to capture screenshot: ${(e as Error).message}`);
            }

            // Attach screenshot to step tracker and mark step as failed
            if (stepTracker) {
                if (screenshotFilename) {
                    stepTracker.screenshot(screenshotFilename);
                }
                stepTracker.failStep(error.message);
            }

            // Save trace on failure
            try {
                await this.browserManager?.saveTraceIfNeeded?.('failed');
            } catch (e) {
                // Ignore trace errors
            }

            // Capture custom annotations and attachments from test.info() (even on failure)
            if (runtimeState) {
                if (runtimeState.annotations && runtimeState.annotations.length > 0) {
                    result.customAnnotations = runtimeState.annotations;
                }
                if (runtimeState.attachments && runtimeState.attachments.length > 0) {
                    result.attachments = runtimeState.attachments;
                }
            }

            // Clean up global state
            if (setCurrentTestState) setCurrentTestState(null);
            if (setCurrentTestInfo) setCurrentTestInfo(null);
        } finally {
            // Get steps from tracker and combine with hook steps
            const testSteps = stepTracker ? stepTracker.finalize() : [];

            // Combine: beforeAll steps + test steps + afterAll steps
            // NOTE: beforeEach/afterEach are stored separately to avoid duplication in report
            result.steps = [...beforeAllSteps, ...testSteps, ...afterAllSteps];

            // Store beforeEach/afterEach steps separately for report hooks section
            result.beforeEachSteps = beforeEachSteps;
            result.afterEachSteps = afterEachSteps;

            // Collect artifacts BEFORE browser cleanup (otherwise they may be deleted)
            result.artifacts = await this.collectArtifacts();

            // Handle browser cleanup/reuse
            // Pass the test status so artifacts are retained/deleted based on config
            await this.handleBrowserCleanup(result.status);
        }

        result.duration = Date.now() - startTime;
        result.endTime = new Date();

        // Update step durations to match test duration
        // Since spec tests typically have one main step "Test Actions", sync its duration with the test duration
        if (result.steps && result.steps.length > 0) {
            // If there's only one step (the implicit "Test Actions" step), use test duration
            if (result.steps.length === 1) {
                result.steps[0].duration = result.duration;
            } else {
                // For multiple steps, distribute remaining time proportionally or use test duration for the last step
                const stepsTotal = result.steps.reduce((sum: number, s: any) => sum + (s.duration || 0), 0);
                if (stepsTotal < result.duration) {
                    // Add the difference to the last step
                    result.steps[result.steps.length - 1].duration += (result.duration - stepsTotal);
                }
            }
        }

        // Add iteration info (name was already set at start with interpolation)
        if (message.iterationNumber) {
            result.iteration = {
                current: message.iterationNumber,
                total: message.totalIterations,
                data: message.dataRow,
                usedColumns: this.getUsedDataColumns(),
                source: message.dataSource ? this.createSourceInfo(message.dataSource) : undefined
            };
        }

        this.sendMessage(result);
    }

    /**
     * Create tracked data with Proxy to track column access
     */
    private createTrackedData(data: any): any {
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
     * Get the columns that were accessed during test execution
     */
    private getUsedDataColumns(): string[] {
        return Array.from(this.usedDataColumns);
    }

    /**
     * Create data source info for reporting
     */
    private createSourceInfo(dataSource: any): any {
        if (!dataSource) return undefined;

        const sourceInfo: any = {
            type: dataSource.type || this.inferTypeFromSource(dataSource.source || '')
        };

        // Interpolate environment placeholders for display in report
        if (dataSource.source) sourceInfo.file = this.interpolateEnvPlaceholders(dataSource.source);
        if (dataSource.sheet) sourceInfo.sheet = dataSource.sheet;
        if (dataSource.filter) sourceInfo.filter = dataSource.filter;
        if (dataSource.query) sourceInfo.query = dataSource.query;
        if (dataSource.connection) sourceInfo.connection = dataSource.connection;
        if (dataSource.delimiter) sourceInfo.delimiter = dataSource.delimiter;

        return sourceInfo;
    }

    /**
     * Interpolate environment placeholders in a string
     */
    private interpolateEnvPlaceholders(source: string): string {
        const env = this.configManager.get('ENVIRONMENT') || this.configManager.get('ENV') || 'dev';
        return source.replace(/\{env\}|\{ENV\}|\{environment\}|\{ENVIRONMENT\}/gi, env);
    }

    /**
     * Infer data type from source file extension
     */
    private inferTypeFromSource(source: string): string {
        const lowerSource = source.toLowerCase();
        if (lowerSource.endsWith('.csv')) return 'csv';
        if (lowerSource.endsWith('.xlsx') || lowerSource.endsWith('.xls')) return 'excel';
        if (lowerSource.endsWith('.json')) return 'json';
        if (lowerSource.endsWith('.xml')) return 'xml';
        if (lowerSource.startsWith('db:')) return 'database';
        return 'inline';
    }

    /**
     * Interpolate data values in a test name
     * Replaces {key} placeholders with values from data object
     */
    private interpolateTestName(testName: string, data: any): string {
        if (!data || typeof data !== 'object') {
            return testName;
        }
        return testName.replace(/\{(\w+)\}/g, (match, key) => {
            return data[key] !== undefined ? String(data[key]) : match;
        });
    }

    /**
     * Create fixtures for test execution
     * @param clearContext - Whether to clear context (false for serial batch tests after the first)
     */
    private async createFixtures(data: any, iteration: any, stepTracker: any, clearContext: boolean = true): Promise<any> {
        const { CSScenarioContext } = this.getModule('../bdd/CSScenarioContext');
        const { CSExpect } = this.getModule('../assertions/CSExpect');
        const { CSAssert } = this.getModule('../assertions/CSAssert');
        const { CSReporter } = this.getModule('../reporter/CSReporter');

        const ctx = CSScenarioContext.getInstance();
        if (clearContext) {
            ctx.clear();
        }

        // Get page from browser manager
        const page = this.browserManager?.getPage?.();
        if (!page) {
            console.warn(`[Worker ${this.workerId}] Warning: No page available from browser manager`);
        }

        // Create page fixtures (loginPage, dashboardPage, etc.)
        const pageFixtures = page ? await this.pageInjector.createPageFixtures(page) : {};
        console.log(`[Worker ${this.workerId}] Created page fixtures: ${Object.keys(pageFixtures).join(', ')}`);

        // Navigate helper with cross-domain support (matches sequential mode)
        const { CSCrossDomainNavigationHandler } = this.getModule('../navigation/CSCrossDomainNavigationHandler');
        const crossDomainHandler = page ? new CSCrossDomainNavigationHandler(page) : null;

        const navigate = async (url: string): Promise<void> => {
            const currentPage = this.browserManager?.getPage?.();
            if (!currentPage) {
                throw new Error('Browser not initialized. Cannot navigate.');
            }

            CSReporter.info(`Navigating to: ${url}`);

            if (crossDomainHandler) {
                // Reset handler state and set target domain
                crossDomainHandler.reset();
                crossDomainHandler.setTargetDomain(url);
                crossDomainHandler.setOriginalDomain(url);
            }

            // Navigate to URL (matching sequential mode behavior)
            await currentPage.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: this.configManager.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
            });

            // Handle cross-domain authentication redirects
            if (crossDomainHandler) {
                await crossDomainHandler.handleInitialAuthRedirect(url);

                if (crossDomainHandler.isInCrossDomainNavigation()) {
                    CSReporter.info('Detected cross-domain authentication redirect, waiting for completion...');
                    await crossDomainHandler.forceWaitForNavigation();
                }
            } else {
                await currentPage.waitForLoadState('load', {
                    timeout: this.configManager.getNumber('BROWSER_NAVIGATION_TIMEOUT', 30000)
                });
            }
        };

        // Create tracked data to monitor column access
        const trackedData = this.createTrackedData(data || {});

        return {
            config: this.configManager,
            ctx,
            data: trackedData,
            iteration: iteration || null,
            reporter: CSReporter,
            stepTracker,
            api: null,
            db: null,
            ado: null,
            expect: CSExpect.getInstance(),
            assert: CSAssert.getInstance(),
            browserManager: this.browserManager,
            page,
            navigate,
            ...pageFixtures
        };
    }

    /**
     * Handle browser cleanup or reuse
     */
    private async handleBrowserCleanup(testStatus: string): Promise<void> {
        if (!this.browserManager) return;

        try {
            const browserReuseEnabled = this.configManager.getBoolean('BROWSER_REUSE_ENABLED', false);
            const clearStateOnReuse = this.configManager.getBoolean('BROWSER_REUSE_CLEAR_STATE', true);
            const closeAfterTests = this.configManager.getNumber('BROWSER_REUSE_CLOSE_AFTER_SCENARIOS', 0);

            if (browserReuseEnabled) {
                this.testCountForReuse++;

                if (closeAfterTests > 0 && this.testCountForReuse >= closeAfterTests) {
                    await this.browserManager.close?.(testStatus);
                    this.testCountForReuse = 0;
                } else if (clearStateOnReuse) {
                    const page = this.browserManager.getPage?.();
                    const context = this.browserManager.getContext?.();

                    if (page && context) {
                        try {
                            await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });
                            await context.clearCookies();
                            await context.clearPermissions();
                            await page.evaluate(() => {
                                try {
                                    localStorage.clear();
                                    sessionStorage.clear();
                                } catch (e) {}
                            });
                            this.browserManager.clearBrowserState?.();
                        } catch (e) {
                            // Ignore cleanup errors
                        }
                    }
                    await this.browserManager.restartTraceForNextScenario?.();
                }
            } else {
                await this.browserManager.close?.(testStatus);
            }
        } catch (e: any) {
            console.debug(`[Worker ${this.workerId}] Browser cleanup error: ${e.message}`);
        }
    }

    /**
     * Collect artifacts from browser manager
     */
    private async collectArtifacts(): Promise<any> {
        const artifacts = {
            screenshots: [] as string[],
            videos: [] as string[],
            traces: [] as string[],
            har: [] as string[]
        };

        if (!this.browserManager) return artifacts;

        try {
            const sessionArtifacts = await this.browserManager.getSessionArtifacts?.();
            if (sessionArtifacts) {
                if (sessionArtifacts.screenshots) artifacts.screenshots = sessionArtifacts.screenshots;
                if (sessionArtifacts.videos) artifacts.videos = sessionArtifacts.videos;
                if (sessionArtifacts.traces) artifacts.traces = sessionArtifacts.traces;
                if (sessionArtifacts.har) artifacts.har = sessionArtifacts.har;
            }
        } catch (e: any) {
            console.debug(`[Worker ${this.workerId}] Artifact collection error: ${e.message}`);
        }

        return artifacts;
    }

    /**
     * Capture failure screenshot
     */
    private async captureFailureScreenshot(testName: string): Promise<string | null> {
        try {
            const page = this.browserManager?.getPage?.();
            if (!page || page.isClosed()) return null;

            const testResultsDir = process.env.TEST_RESULTS_DIR || 'reports/test-results';
            const screenshotsDir = path.join(testResultsDir, 'screenshots');

            if (!fs.existsSync(screenshotsDir)) {
                fs.mkdirSync(screenshotsDir, { recursive: true });
            }

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const safeName = testName.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50);
            const filename = `${safeName}_w${this.workerId}_${timestamp}.png`;
            const fullPath = path.join(screenshotsDir, filename);

            await page.screenshot({ path: fullPath, fullPage: false });
            console.log(`[Worker ${this.workerId}] Screenshot captured: ${filename}`);

            return fullPath;
        } catch (e: any) {
            console.debug(`[Worker ${this.workerId}] Screenshot error: ${e.message}`);
            return null;
        }
    }

    private sendMessage(message: any): void {
        try {
            if (!process.send || !process.connected) return;
            process.send(message);
        } catch (error: any) {
            if (error.code !== 'EPIPE') {
                console.error(`[Worker ${this.workerId}] Send error: ${error.message}`);
            }
        }
    }

    private async cleanup(): Promise<void> {
        const finalStatus = this.anyTestFailed ? 'failed' : 'passed';
        console.log(`[Worker ${this.workerId}] Cleaning up... (anyTestFailed: ${this.anyTestFailed}, finalStatus: ${finalStatus})`);
        try {
            if (this.browserManager) {
                await this.browserManager.closeAll?.(finalStatus);
            }
        } catch (e: any) {
            console.error(`[Worker ${this.workerId}] Cleanup error: ${e.message}`);
        }
    }
}

// Start worker if run directly
if (require.main === module) {
    new SpecWorkerProcess();
}

export { SpecWorkerProcess };
