/**
 * Parallel Orchestrator for Spec Format Tests
 * Uses child processes (fork) for true parallel execution with isolated browsers
 * Based on BDD parallel-orchestrator.ts pattern
 */

import { ChildProcess, fork } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSTestResultsManager } from '../reporter/CSTestResultsManager';
import { SpecRunnerOptions, SpecTestResult, SpecSuiteResult, RegisteredTest, RegisteredDescribe, SpecDataRow, SpecDataSource, SpecSerialBatch } from './CSSpecTypes';
import { CSSpecDataIterator } from './CSSpecDataIterator';

/**
 * Work item for spec test execution
 */
interface SpecWorkItem {
    id: string;
    type: 'single' | 'serial-batch';
    testName: string;
    describeName: string;
    specFilePath: string;
    testIndex: number;
    describeIndex: number;
    options: SpecRunnerOptions;
    iterationNumber?: number;
    totalIterations?: number;
    dataRow?: Record<string, any>;
    dataSource?: SpecDataSource;  // Data source info for reporting
    // For serial batch
    serialBatch?: SpecSerialBatch;
}

/**
 * Worker process wrapper
 */
interface SpecWorker {
    id: number;
    process: ChildProcess;
    busy: boolean;
    currentWork?: SpecWorkItem;
    assignedAt?: number;
    errorCount: number;
}

/**
 * Parallel Orchestrator for Spec Format
 */
export class CSSpecParallelOrchestrator {
    private workers: Map<number, SpecWorker> = new Map();
    private workQueue: SpecWorkItem[] = [];
    private results: Map<string, SpecTestResult> = new Map();
    private config = CSConfigurationManager.getInstance();
    private resultsManager = CSTestResultsManager.getInstance();
    private completedCount = 0;
    private totalCount = 0;
    private maxWorkers: number;
    private adoIntegration: any = null;

    constructor(maxWorkers?: number) {
        this.maxWorkers = maxWorkers ||
            parseInt(process.env.PARALLEL_WORKERS || '0') ||
            Math.min(os.cpus().length, 4);
    }

    /**
     * Check if a test function uses the 'data' fixture parameter
     * Used for smart data-driven iteration control
     */
    private testUsesDataFixture(fn: Function): boolean {
        try {
            const fnStr = fn.toString();

            // Pattern 1: Destructured 'data' in parameter - { data } or { data, ... }
            const destructuredPattern = /\(\s*\{[^}]*\bdata\b[^}]*\}\s*\)/;

            // Pattern 2: Renamed destructuring - { data: something }
            const renamedPattern = /\(\s*\{[^}]*\bdata\s*:/;

            // Pattern 3: Direct 'data.' usage in function body
            const directUsagePattern = /\bdata\./;

            if (destructuredPattern.test(fnStr) || renamedPattern.test(fnStr)) {
                return true;
            }

            // Check for data. usage in function body
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
            return true;
        }
    }

    /**
     * Determine if test should iterate over data rows
     * Respects useData option and auto-detects data fixture usage
     */
    private shouldTestIterateWithData(
        test: RegisteredTest,
        describe: RegisteredDescribe,
        dataRows: SpecDataRow[]
    ): boolean {
        const testHasOwnDataSource = !!test.options.dataSource;
        const describeHasDataSource = !!describe.options.dataSource;

        // Test has own dataSource - always iterate
        if (testHasOwnDataSource) {
            return true;
        }

        // No describe-level data source or no rows - no iteration
        if (!describeHasDataSource || dataRows.length === 0) {
            return false;
        }

        // Check useData option
        const useData = test.options.useData;

        if (useData === false) {
            CSReporter.debug(`[SpecParallel] Test "${test.name}" has useData: false, skipping data iterations`);
            return false;
        }

        if (useData === undefined) {
            // Auto-detect: check if test function uses 'data' parameter
            const usesData = this.testUsesDataFixture(test.fn);
            if (!usesData) {
                CSReporter.debug(`[SpecParallel] Test "${test.name}" doesn't use 'data' fixture, skipping data iterations`);
                return false;
            }
        }

        // useData === true or auto-detect found data usage
        return true;
    }

    /**
     * Execute spec tests in parallel
     */
    public async execute(
        specFiles: string[],
        collectedTests: Array<{
            test: RegisteredTest;
            describe: RegisteredDescribe;
            parentDescribes: RegisteredDescribe[];
            specFilePath: string;
        }>,
        options: SpecRunnerOptions
    ): Promise<Map<string, SpecTestResult>> {
        CSReporter.info(`[SpecParallel] Starting parallel execution with ${this.maxWorkers} workers`);

        // Create work items from collected tests
        await this.createWorkItems(collectedTests, options);

        // Calculate total test count (batches contain multiple tests)
        this.totalCount = 0;
        for (const work of this.workQueue) {
            if (work.type === 'serial-batch' && work.serialBatch) {
                this.totalCount += work.serialBatch.tests.length;
            } else {
                this.totalCount += 1;
            }
        }
        CSReporter.info(`[SpecParallel] Total tests to execute: ${this.totalCount} (${this.workQueue.length} work items)`);

        if (this.totalCount === 0) {
            return this.results;
        }

        // Start worker processes
        await this.startWorkers(options);

        // Wait for all tests to complete
        await this.waitForCompletion();

        // Cleanup workers
        await this.cleanup();

        CSReporter.info(`[SpecParallel] Parallel execution completed: ${this.completedCount}/${this.totalCount} tests`);
        return this.results;
    }

    /**
     * Create work items from collected tests
     * Handles serial mode describes by grouping tests into batches
     */
    private async createWorkItems(
        collectedTests: Array<{
            test: RegisteredTest;
            describe: RegisteredDescribe;
            parentDescribes: RegisteredDescribe[];
            specFilePath: string;
        }>,
        options: SpecRunnerOptions
    ): Promise<void> {
        let workId = 0;
        let batchId = 0;
        const dataIterator = CSSpecDataIterator.getInstance();

        // Group tests by describe for serial mode handling
        const describeGroups = new Map<string, Array<{
            test: RegisteredTest;
            describe: RegisteredDescribe;
            parentDescribes: RegisteredDescribe[];
            specFilePath: string;
            testIndex: number;
        }>>();

        for (let i = 0; i < collectedTests.length; i++) {
            const item = collectedTests[i];
            const key = `${item.specFilePath}::${item.describe.name}`;
            if (!describeGroups.has(key)) {
                describeGroups.set(key, []);
            }
            describeGroups.get(key)!.push({ ...item, testIndex: i });
        }

        // Process each describe group
        for (const [key, tests] of describeGroups) {
            const describe = tests[0].describe;
            const isSerialMode = describe.options.mode === 'serial';
            const isFixme = describe.options.fixme;
            const isWorkflow = describe.options.tags?.includes?.('@workflow') ||
                (Array.isArray(describe.options.tags) && describe.options.tags.includes('@workflow'));

            // Check for tests with dependsOn - warn if not in serial mode
            for (const { test } of tests) {
                if (test.options.dependsOn && !isSerialMode && !isWorkflow) {
                    CSReporter.warn(`[SpecParallel] Test "${test.name}" has dependsOn but describe is not in serial mode. Dependencies may not work correctly in parallel execution. Consider using describe.serial() or describe.workflow().`);
                }
            }

            // Handle fixme describes - skip all tests
            if (isFixme) {
                CSReporter.debug(`[SpecParallel] Describe "${describe.name}" marked as fixme - skipping all tests`);
                for (const { test, describe: desc, specFilePath, testIndex } of tests) {
                    this.workQueue.push({
                        id: `work-${++workId}`,
                        type: 'single',
                        testName: test.name,
                        describeName: desc.name,
                        specFilePath,
                        testIndex,
                        describeIndex: 0,
                        options,
                        // Mark as fixme by adding special flag
                        dataRow: { __fixme: typeof isFixme === 'string' ? isFixme : 'Describe marked as fixme' }
                    });
                }
                continue;
            }

            if (isSerialMode) {
                // Serial mode handling:
                // - If describe has MULTIPLE different test definitions: batch them together (true serial dependency)
                // - If describe has SINGLE data-driven test: distribute iterations across workers (iterations are independent)

                const hasMultipleTestDefinitions = tests.length > 1;
                const singleTest = tests.length === 1 ? tests[0] : null;
                const singleTestDataSource = singleTest ? (singleTest.test.options.dataSource || singleTest.describe.options.dataSource) : null;

                if (hasMultipleTestDefinitions || !singleTestDataSource) {
                    // Multiple tests or non-data-driven: Create serial batch (original behavior)
                    CSReporter.debug(`[SpecParallel] Creating serial batch for describe: ${describe.name} (${tests.length} tests)`);

                    const batchTests: SpecSerialBatch['tests'] = [];

                    for (const { test, describe: desc, parentDescribes, specFilePath, testIndex } of tests) {
                        // Handle data-driven tests within serial batch
                        const dataSource = test.options.dataSource || desc.options.dataSource;

                        if (dataSource) {
                            let dataRows: SpecDataRow[] = [];
                            try {
                                dataRows = await dataIterator.loadData(dataSource);
                            } catch (error: any) {
                                CSReporter.error(`[SpecParallel] Failed to load data for serial test ${test.name}: ${error.message}`);
                                dataRows = [{}];
                            }

                            // Check if this test should iterate with data
                            const shouldIterate = this.shouldTestIterateWithData(test, desc, dataRows);

                            if (shouldIterate && dataRows.length > 0) {
                                for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
                                    batchTests.push({
                                        test,
                                        describe: desc,
                                        parentDescribes,
                                        iterationNumber: rowIndex + 1,
                                        totalIterations: dataRows.length,
                                        dataRow: dataRows[rowIndex]
                                    });
                                }
                            } else {
                                // Test opted out or no data - add once without iteration
                                batchTests.push({ test, describe: desc, parentDescribes });
                            }
                        } else {
                            batchTests.push({ test, describe: desc, parentDescribes });
                        }
                    }

                    // Create single batch work item
                    const batch: SpecSerialBatch = {
                        id: `batch-${++batchId}`,
                        describeName: describe.name,
                        specFilePath: tests[0].specFilePath,
                        tests: batchTests,
                        options
                    };

                    this.workQueue.push({
                        id: `work-${++workId}`,
                        type: 'serial-batch',
                        testName: `[Serial Batch] ${describe.name}`,
                        describeName: describe.name,
                        specFilePath: tests[0].specFilePath,
                        testIndex: tests[0].testIndex,
                        describeIndex: 0,
                        options,
                        serialBatch: batch
                    });
                } else {
                    // Single data-driven test in serial describe: distribute iterations across workers
                    CSReporter.debug(`[SpecParallel] Distributing data-driven iterations for: ${describe.name}`);

                    const { test, describe: desc, parentDescribes, specFilePath, testIndex } = singleTest!;
                    let dataRows: SpecDataRow[] = [];

                    try {
                        dataRows = await dataIterator.loadData(singleTestDataSource);
                        CSReporter.info(`[SpecParallel] Distributing ${dataRows.length} iterations across workers for: ${test.name}`);
                    } catch (error: any) {
                        CSReporter.error(`[SpecParallel] Failed to load data for test ${test.name}: ${error.message}`);
                        dataRows = [{}];
                    }

                    // Check if this test should iterate with data
                    const shouldIterate = this.shouldTestIterateWithData(test, desc, dataRows);

                    if (shouldIterate && dataRows.length > 0) {
                        // Create individual work items for each iteration (can run in parallel)
                        for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
                            this.workQueue.push({
                                id: `work-${++workId}`,
                                type: 'single',
                                testName: test.name,
                                describeName: desc.name,
                                specFilePath,
                                testIndex,
                                describeIndex: 0,
                                options,
                                iterationNumber: rowIndex + 1,
                                totalIterations: dataRows.length,
                                dataRow: dataRows[rowIndex],
                                dataSource: singleTestDataSource  // Pass data source info for reporting
                            });
                        }
                    } else {
                        // Test opted out of data iterations - run once
                        CSReporter.debug(`[SpecParallel] Test "${test.name}" running once (no data iterations)`);
                        this.workQueue.push({
                            id: `work-${++workId}`,
                            type: 'single',
                            testName: test.name,
                            describeName: desc.name,
                            specFilePath,
                            testIndex,
                            describeIndex: 0,
                            options
                        });
                    }
                }

            } else {
                // Parallel mode (default): Create individual work items
                for (const { test, describe: desc, parentDescribes, specFilePath, testIndex } of tests) {
                    const dataSource = test.options.dataSource || desc.options.dataSource;

                    if (dataSource) {
                        let dataRows: SpecDataRow[] = [];
                        try {
                            dataRows = await dataIterator.loadData(dataSource);
                            CSReporter.debug(`[SpecParallel] Loaded ${dataRows.length} data rows for test: ${test.name}`);
                        } catch (error: any) {
                            CSReporter.error(`[SpecParallel] Failed to load data for test ${test.name}: ${error.message}`);
                            this.workQueue.push({
                                id: `work-${++workId}`,
                                type: 'single',
                                testName: test.name,
                                describeName: desc.name,
                                specFilePath,
                                testIndex,
                                describeIndex: 0,
                                options
                            });
                            continue;
                        }

                        // Check if this test should iterate with data
                        const shouldIterate = this.shouldTestIterateWithData(test, desc, dataRows);

                        if (shouldIterate && dataRows.length > 0) {
                            for (let rowIndex = 0; rowIndex < dataRows.length; rowIndex++) {
                                this.workQueue.push({
                                    id: `work-${++workId}`,
                                    type: 'single',
                                    testName: test.name,
                                    describeName: desc.name,
                                    specFilePath,
                                    testIndex,
                                    describeIndex: 0,
                                    options,
                                    iterationNumber: rowIndex + 1,
                                    totalIterations: dataRows.length,
                                    dataRow: dataRows[rowIndex],
                                    dataSource  // Pass data source info for reporting
                                });
                            }
                        } else {
                            // Test opted out of data iterations or no data - run once
                            CSReporter.debug(`[SpecParallel] Test "${test.name}" running once (no data iterations)`);
                            this.workQueue.push({
                                id: `work-${++workId}`,
                                type: 'single',
                                testName: test.name,
                                describeName: desc.name,
                                specFilePath,
                                testIndex,
                                describeIndex: 0,
                                options
                            });
                        }
                    } else {
                        this.workQueue.push({
                            id: `work-${++workId}`,
                            type: 'single',
                            testName: test.name,
                            describeName: desc.name,
                            specFilePath,
                            testIndex,
                            describeIndex: 0,
                            options
                        });
                    }
                }
            }
        }
    }

    /**
     * Start worker processes
     */
    private async startWorkers(options: SpecRunnerOptions): Promise<void> {
        const ext = __filename.endsWith('.ts') ? '.ts' : '.js';
        const workerScript = path.join(__dirname, `CSSpecWorkerProcess${ext}`);
        const workersNeeded = Math.min(this.maxWorkers, this.totalCount);

        CSReporter.info(`[SpecParallel] Starting ${workersNeeded} worker processes...`);
        const startTime = Date.now();

        // Create all workers in parallel
        const workerPromises: Promise<SpecWorker>[] = [];
        for (let i = 1; i <= workersNeeded; i++) {
            workerPromises.push(this.createWorker(i, workerScript, options));
        }

        const workers = await Promise.all(workerPromises);
        CSReporter.info(`[SpecParallel] All workers ready in ${Date.now() - startTime}ms`);

        // Store workers and assign initial work
        for (const worker of workers) {
            this.workers.set(worker.id, worker);
            setImmediate(() => this.assignWork(worker));
        }
    }

    /**
     * Create a single worker process
     */
    private createWorker(id: number, script: string, options: SpecRunnerOptions): Promise<SpecWorker> {
        return new Promise((resolve, reject) => {
            const project = options.project || this.config.get('PROJECT', 'common');

            // Get decrypted configuration values
            const configValues: Record<string, string> = {};
            const configKeys = [
                'ADO_PAT', 'ADO_ORGANIZATION', 'ADO_PROJECT', 'ADO_BASE_URL',
                'ADO_ENABLED', 'ADO_DRY_RUN', 'ADO_TEST_PLAN_ID', 'ADO_TEST_SUITE_ID',
                'BROWSER_VIDEO', 'HAR_CAPTURE_MODE', 'TRACE_CAPTURE_MODE',
                'HEADLESS', 'BROWSER', 'TIMEOUT', 'DEFAULT_TIMEOUT',
                'BROWSER_REUSE_ENABLED', 'BROWSER_REUSE_CLEAR_STATE'
            ];

            for (const key of configKeys) {
                const value = this.config.get(key);
                if (value !== undefined && value !== null) {
                    configValues[key] = String(value);
                }
            }

            // Fork configuration
            const isTypeScript = script.endsWith('.ts');
            const workerHeapSize = this.config.getNumber('WORKER_HEAP_SIZE', 1024);

            const execArgv = isTypeScript ? [
                '-r', 'ts-node/register',
                `--max-old-space-size=${workerHeapSize}`,
                '--no-warnings'
            ] : [
                `--max-old-space-size=${workerHeapSize}`,
                '--no-warnings'
            ];

            const workerProcess = fork(script, [], {
                execArgv,
                env: {
                    ...process.env,
                    ...configValues,
                    WORKER_ID: String(id),
                    IS_WORKER: 'true',
                    PROJECT: project,
                    ENVIRONMENT: options.env || process.env.ENVIRONMENT,
                    TS_NODE_TRANSPILE_ONLY: 'true',
                    TS_NODE_FILES: 'false',
                    TS_NODE_CACHE: 'true',
                    TEST_RESULTS_DIR: this.resultsManager.getCurrentTestRunDir()
                },
                silent: false,
                serialization: 'advanced'
            });

            const worker: SpecWorker = {
                id,
                process: workerProcess,
                busy: false,
                errorCount: 0
            };

            workerProcess.on('message', (message: any) => {
                this.handleWorkerMessage(worker, message);
            });

            workerProcess.on('error', (error) => {
                CSReporter.error(`[SpecParallel] Worker ${id} error: ${error.message}`);
                reject(error);
            });

            workerProcess.on('exit', (code) => {
                if (code !== 0 && code !== null) {
                    CSReporter.warn(`[SpecParallel] Worker ${id} exited with code ${code}`);
                }
                this.workers.delete(id);
            });

            // Wait for ready message
            const onReady = (message: any) => {
                if (message.type === 'ready') {
                    workerProcess.removeListener('message', onReady);
                    resolve(worker);
                }
            };
            workerProcess.on('message', onReady);

            // Timeout for worker initialization
            setTimeout(() => {
                reject(new Error(`Worker ${id} failed to start within timeout`));
            }, 15000);
        });
    }

    /**
     * Handle messages from worker processes
     */
    private handleWorkerMessage(worker: SpecWorker, message: any): void {
        switch (message.type) {
            case 'result':
                this.handleResult(worker, message);
                break;
            case 'batch-result':
                this.handleBatchResult(worker, message);
                break;
            case 'error':
                CSReporter.error(`[SpecParallel] Worker ${worker.id} error: ${message.error}`);
                this.handleWorkerError(worker, message);
                break;
            case 'log':
                CSReporter.debug(`[Worker ${worker.id}] ${message.message}`);
                break;
        }
    }

    /**
     * Handle batch result from worker (serial mode)
     */
    private handleBatchResult(worker: SpecWorker, message: any): void {
        if (!worker.currentWork) {
            CSReporter.warn(`[SpecParallel] Received batch result without current work`);
            return;
        }

        const work = worker.currentWork;
        const results = message.results || [];

        CSReporter.info(`[SpecParallel] Worker ${worker.id} completed serial batch: ${work.describeName} (${results.length} results)`);

        // Store each result from the batch
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const resultId = `${work.id}-${i}`;

            const testResult: SpecTestResult = {
                name: result.name,
                describeName: result.describeName || work.describeName,
                status: result.status,
                duration: result.duration || 0,
                startTime: new Date(result.startTime),
                endTime: new Date(result.endTime),
                steps: result.steps || [],
                screenshots: result.screenshots || [],
                tags: result.tags || [],
                error: result.error,
                stack: result.stackTrace,
                video: result.video,
                trace: result.trace,
                har: result.har,
                iteration: result.iteration,
                workerId: String(worker.id),
                skipReason: result.skipReason,
                attachments: result.attachments,
                customAnnotations: result.customAnnotations,
                beforeEachSteps: result.beforeEachSteps,
                afterEachSteps: result.afterEachSteps
            };

            // Store original test name for data-driven grouping
            (testResult as any).originalTestName = result.originalTestName || result.name;

            this.results.set(resultId, testResult);
            this.completedCount++;

            const statusSymbol = result.status === 'passed' ? '✓' :
                                result.status === 'skipped' ? '⊘' :
                                result.status === 'fixme' ? '⚠' : '✗';
            CSReporter.info(`[${this.completedCount}/${this.totalCount}] ${statusSymbol} ${testResult.name} (${result.duration}ms) [Worker ${worker.id}]`);
        }

        worker.busy = false;
        worker.currentWork = undefined;

        // Assign next work
        this.assignWork(worker);
    }

    /**
     * Handle test result from worker
     */
    private handleResult(worker: SpecWorker, result: any): void {
        if (worker.currentWork) {
            const work = worker.currentWork;

            // Create test result from worker result
            // IMPORTANT: For data-driven tests, preserve the original test name (template)
            // for proper grouping in ADO, while using display name for reporting
            const testResult: SpecTestResult = {
                name: result.name || work.testName,
                describeName: result.describeName || work.describeName,
                status: result.status,
                duration: result.duration || 0,
                startTime: new Date(result.startTime),
                endTime: new Date(result.endTime),
                steps: result.steps || [],
                screenshots: result.screenshots || [],
                tags: result.tags || [],
                error: result.error,
                stack: result.stackTrace,
                video: result.video,
                trace: result.trace,
                har: result.har,
                iteration: result.iteration,
                workerId: String(worker.id),
                attachments: result.attachments,
                customAnnotations: result.customAnnotations,
                beforeEachSteps: result.beforeEachSteps,
                afterEachSteps: result.afterEachSteps
            };

            // Store original test name for data-driven test grouping
            (testResult as any).originalTestName = work.testName;

            this.results.set(work.id, testResult);
            this.completedCount++;

            const statusSymbol = result.status === 'passed' ? '✓' : '✗';
            CSReporter.info(`[${this.completedCount}/${this.totalCount}] ${statusSymbol} ${testResult.name} (${result.duration}ms) [Worker ${worker.id}]`);

            worker.busy = false;
            worker.currentWork = undefined;

            // Assign next work
            this.assignWork(worker);
        }
    }

    /**
     * Handle worker error
     */
    private handleWorkerError(worker: SpecWorker, error: any): void {
        worker.errorCount++;

        if (worker.errorCount > 3) {
            CSReporter.warn(`[SpecParallel] Worker ${worker.id} has ${worker.errorCount} errors, recycling...`);
            this.recycleWorker(worker);
        } else {
            worker.busy = false;
            this.assignWork(worker);
        }
    }

    /**
     * Assign work to a worker
     * Handles both single tests and serial batches
     */
    private assignWork(worker: SpecWorker): void {
        if (worker.busy || this.workQueue.length === 0) {
            return;
        }

        const work = this.workQueue.shift()!;
        worker.busy = true;
        worker.currentWork = work;
        worker.assignedAt = Date.now();

        if (work.type === 'serial-batch' && work.serialBatch) {
            // Send serial batch to worker
            CSReporter.debug(`[SpecParallel] Worker ${worker.id} assigned serial batch: ${work.describeName} (${work.serialBatch.tests.length} tests)`);

            worker.process.send({
                type: 'execute-batch',
                workId: work.id,
                batchId: work.serialBatch.id,
                describeName: work.describeName,
                specFilePath: work.specFilePath,
                tests: work.serialBatch.tests.map(t => ({
                    testName: t.test.name,
                    iterationNumber: t.iterationNumber,
                    totalIterations: t.totalIterations,
                    dataRow: t.dataRow
                })),
                options: work.options,
                testResultsDir: this.resultsManager.getCurrentTestRunDir()
            });
        } else {
            // Send single test to worker
            worker.process.send({
                type: 'execute',
                workId: work.id,
                testName: work.testName,
                describeName: work.describeName,
                specFilePath: work.specFilePath,
                testIndex: work.testIndex,
                options: work.options,
                iterationNumber: work.iterationNumber,
                totalIterations: work.totalIterations,
                dataRow: work.dataRow,
                dataSource: work.dataSource,  // Pass data source info for reporting
                testResultsDir: this.resultsManager.getCurrentTestRunDir()
            });

            CSReporter.debug(`[SpecParallel] Worker ${worker.id} assigned: ${work.testName}`);
        }
    }

    /**
     * Recycle a worker that has issues
     */
    private async recycleWorker(worker: SpecWorker): Promise<void> {
        this.workers.delete(worker.id);

        try {
            worker.process.kill();
        } catch (e) {
            // Ignore
        }

        // Re-queue current work if any
        if (worker.currentWork) {
            this.workQueue.unshift(worker.currentWork);
        }

        // Create replacement worker
        const ext = __filename.endsWith('.ts') ? '.ts' : '.js';
        const workerScript = path.join(__dirname, `CSSpecWorkerProcess${ext}`);
        const newWorker = await this.createWorker(
            worker.id,
            workerScript,
            worker.currentWork?.options || {} as SpecRunnerOptions
        );
        this.workers.set(newWorker.id, newWorker);
        this.assignWork(newWorker);
    }

    /**
     * Wait for all work to complete
     */
    private waitForCompletion(): Promise<void> {
        return new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                if (this.completedCount >= this.totalCount) {
                    clearInterval(checkInterval);
                    resolve();
                }

                // Check for stuck workers
                const now = Date.now();
                for (const worker of this.workers.values()) {
                    if (worker.busy && worker.assignedAt) {
                        const elapsed = now - worker.assignedAt;
                        if (elapsed > 120000) { // 2 minute timeout
                            CSReporter.warn(`[SpecParallel] Worker ${worker.id} timeout on: ${worker.currentWork?.testName}`);
                            this.recycleWorker(worker);
                        }
                    }
                }
            }, 100);

            // Overall timeout
            setTimeout(() => {
                clearInterval(checkInterval);
                CSReporter.warn('[SpecParallel] Parallel execution timed out');
                resolve();
            }, 600000); // 10 minutes
        });
    }

    /**
     * Cleanup all workers
     */
    private async cleanup(): Promise<void> {
        CSReporter.debug('[SpecParallel] Cleaning up workers...');
        const cleanupStart = Date.now();

        const terminationPromises: Promise<void>[] = [];

        for (const worker of this.workers.values()) {
            terminationPromises.push(new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    if (worker.process.connected) {
                        worker.process.kill('SIGKILL');
                    }
                    resolve();
                }, 20000);

                worker.process.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });

                if (worker.process.connected) {
                    worker.process.send({ type: 'terminate' });
                } else {
                    resolve();
                }
            }));
        }

        await Promise.all(terminationPromises);
        this.workers.clear();

        CSReporter.debug(`[SpecParallel] Cleanup completed in ${Date.now() - cleanupStart}ms`);
    }

    /**
     * Get collected results
     */
    public getResults(): Map<string, SpecTestResult> {
        return this.results;
    }
}
