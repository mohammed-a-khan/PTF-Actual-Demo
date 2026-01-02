/**
 * Parallel test orchestrator
 * Manages child processes for parallel test execution
 */

import { ChildProcess, fork } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { ParsedFeature, ParsedScenario, ParsedExamples } from '../bdd/CSBDDEngine';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSDataProvider } from '../data/CSDataProvider';
import { CSADOIntegration } from '../ado/CSADOIntegration';
import { CSTestResultsManager } from '../reporter/CSTestResultsManager';

interface WorkItem {
    id: string;
    feature: ParsedFeature;
    scenario: ParsedScenario;
    scenarioIndex: number;
    exampleRow?: string[];
    exampleHeaders?: string[];
    iterationNumber?: number;
    totalIterations?: number;
}

interface Worker {
    id: number;
    process: ChildProcess;
    busy: boolean;
    currentWork?: WorkItem;
    assignedAt?: number;
    errorCount?: number;
}

export class ParallelOrchestrator {
    private workers: Map<number, Worker> = new Map();
    private workQueue: WorkItem[] = [];
    private results: Map<string, any> = new Map();
    private config = CSConfigurationManager.getInstance();
    private resultsManager = CSTestResultsManager.getInstance();
    private completedCount = 0;
    private totalCount = 0;
    private maxWorkers: number;
    private adoIntegration: any;
    private dataDrivenResults: Map<string, any[]> = new Map(); // Group iterations by scenario base name
    private performanceMetrics: Map<string, any> = new Map();
    private workerPool: Worker[] = []; // Reusable worker pool
    private reuseWorkers: boolean = true;

    constructor(maxWorkers?: number) {
        this.maxWorkers = maxWorkers || parseInt(process.env.PARALLEL_WORKERS || '0') || os.cpus().length;
        this.reuseWorkers = this.config.getBoolean('REUSE_WORKERS', true);
    }

    /**
     * Execute features in parallel
     */
    public async execute(features: ParsedFeature[]): Promise<Map<string, any>> {
        CSReporter.info(`Starting parallel execution with ${this.maxWorkers} workers`);

        // Initialize ADO integration for parallel mode
        this.adoIntegration = CSADOIntegration.getInstance();
        await this.adoIntegration.initialize(true);

        // Collect all scenarios for ADO test point mapping BEFORE creating test run
        const allScenarios: Array<{scenario: ParsedScenario, feature: ParsedFeature}> = [];
        for (const feature of features) {
            for (const scenario of feature.scenarios || []) {
                allScenarios.push({scenario, feature});
            }
        }
        await this.adoIntegration.collectScenarios(allScenarios);

        // Now start the test run with collected test points
        await this.adoIntegration.beforeAllTests(`PTF Parallel Run - ${new Date().toISOString()}`);

        // Create work items (now async to handle data loading)
        await this.createWorkItems(features);
        this.totalCount = this.workQueue.length;
        CSReporter.info(`Total scenarios to execute: ${this.totalCount}`);

        if (this.totalCount === 0) {
            return this.results;
        }

        // Start workers
        await this.startWorkers();

        // Wait for completion
        await this.waitForCompletion();

        // Cleanup
        await this.cleanup();

        // Note: ADO test run completion is now handled in CSBDDRunner after reports are generated
        // to ensure all artifacts (including HTML reports) are included in the zip

        CSReporter.info(`Parallel execution completed: ${this.completedCount}/${this.totalCount} scenarios`);
        return this.results;
    }

    /**
     * Load external data for scenario examples
     */
    private async loadExamplesData(examples: ParsedExamples): Promise<ParsedExamples> {
        // If no external data source, return as is
        if (!examples.dataSource) {
            return examples;
        }

        const dataProvider = CSDataProvider.getInstance();
        const source = examples.dataSource;

        try {
            CSReporter.info(`Loading external data from ${source.type}: ${source.source}`);

            // Build data provider options
            const options: any = {
                source: source.source,
                type: source.type
            };

            // Add type-specific options
            if (source.sheet) options.sheet = source.sheet;
            if (source.delimiter) options.delimiter = source.delimiter;
            if (source.filter) {
                // Parse and apply filter expression
                options.filter = this.createFilterFunction(source.filter);
            }

            // Load data
            const data = await dataProvider.loadData(options);

            if (data.length === 0) {
                CSReporter.warn(`No data loaded from external source: ${source.source}`);
                return examples;
            }

            // Extract headers and rows
            // For arrays and objects, JSON.stringify them to preserve structure
            // Otherwise convert to string normally
            const headers = Object.keys(data[0]);
            const rows = data.map(item => headers.map(h => {
                const value = item[h];
                if (value === null || value === undefined) return '';
                if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
                    return JSON.stringify(value);
                }
                return String(value);
            }));

            CSReporter.info(`Loaded ${rows.length} rows with headers: ${headers.join(', ')}`);

            return {
                ...examples,
                headers,
                rows
            };
        } catch (error: any) {
            CSReporter.error(`Failed to load external data: ${error.message}`);
            // Return original examples as fallback
            return examples;
        }
    }

    /**
     * Create a filter function from filter expression
     */
    private createFilterFunction(filterExpr: string): (row: any) => boolean {
        // Simple filter implementation
        // Format: "column=value" or "column!=value" or "column>value" etc.
        const match = filterExpr.match(/^(\w+)\s*(=|!=|>|<|>=|<=)\s*(.+)$/);
        if (!match) {
            CSReporter.warn(`Invalid filter expression: ${filterExpr}`);
            return () => true;
        }

        const [, column, operator, value] = match;
        const cleanValue = value.replace(/^["']|["']$/g, ''); // Remove quotes

        return (row: any) => {
            const cellValue = String(row[column] || '');
            switch (operator) {
                case '=':
                    return cellValue === cleanValue;
                case '!=':
                    return cellValue !== cleanValue;
                case '>':
                    return Number(cellValue) > Number(cleanValue);
                case '<':
                    return Number(cellValue) < Number(cleanValue);
                case '>=':
                    return Number(cellValue) >= Number(cleanValue);
                case '<=':
                    return Number(cellValue) <= Number(cleanValue);
                default:
                    return true;
            }
        };
    }

    /**
     * Check if scenario is enabled based on @enabled tag
     * Default is true (enabled) if no @enabled tag is present
     */
    private isScenarioEnabled(scenario: ParsedScenario, feature: ParsedFeature): boolean {
        const allTags = [...(feature.tags || []), ...(scenario.tags || [])];
        const enabledTag = allTags.find(tag =>
            tag.toLowerCase().startsWith('@enabled:') || tag.toLowerCase().startsWith('enabled:')
        );
        if (enabledTag) {
            const value = enabledTag.split(':')[1]?.toLowerCase().trim();
            if (value === 'false' || value === 'no' || value === '0') {
                return false;
            }
        }
        return true;
    }

    private async createWorkItems(features: ParsedFeature[]) {
        let workId = 0;

        for (const feature of features) {
            for (let i = 0; i < feature.scenarios.length; i++) {
                const scenario = feature.scenarios[i];

                // Check if scenario is enabled via @enabled tag
                if (!this.isScenarioEnabled(scenario, feature)) {
                    CSReporter.debug(`[Parallel] Skipping disabled scenario: ${scenario.name}`);
                    continue;
                }

                // Check if scenario has examples (scenario outline)
                if (scenario.examples) {
                    // Load external data if configured
                    const examples = await this.loadExamplesData(scenario.examples);

                    if (examples.rows.length > 0) {
                        // Create a work item for each example row
                        let iterationNumber = 1;
                        for (const row of examples.rows) {
                            const scenarioWithBackground = {
                                ...scenario,
                                background: feature.background
                            };

                            this.workQueue.push({
                                id: `work-${++workId}`,
                                feature,
                                scenario: scenarioWithBackground as ParsedScenario,
                                scenarioIndex: i,
                                exampleRow: row,
                                exampleHeaders: examples.headers,
                                iterationNumber,
                                totalIterations: examples.rows.length
                            });
                            iterationNumber++;
                        }
                    } else {
                        // No data rows, treat as regular scenario
                        const scenarioWithBackground = {
                            ...scenario,
                            background: feature.background
                        };

                        this.workQueue.push({
                            id: `work-${++workId}`,
                            feature,
                            scenario: scenarioWithBackground as ParsedScenario,
                            scenarioIndex: i
                        });
                    }
                } else {
                    // Regular scenario (not a scenario outline)
                    const scenarioWithBackground = {
                        ...scenario,
                        background: feature.background
                    };

                    this.workQueue.push({
                        id: `work-${++workId}`,
                        feature,
                        scenario: scenarioWithBackground as ParsedScenario,
                        scenarioIndex: i
                    });
                }
            }
        }
    }

    private async startWorkers(): Promise<void> {
        // Use .js extension for compiled code, .ts for ts-node
        const ext = __filename.endsWith('.ts') ? '.ts' : '.js';
        const workerScript = path.join(__dirname, `worker-process${ext}`);
        const workersNeeded = Math.min(this.maxWorkers, this.totalCount);

        // Get the test results directory from the parent
        const testResultsDir = this.resultsManager.getCurrentTestRunDir();

        CSReporter.info(`[Perf] Starting ${workersNeeded} workers in parallel...`);
        const startTime = Date.now();

        // Create all workers in parallel for faster startup
        const promises = [];
        for (let i = 1; i <= workersNeeded; i++) {
            promises.push(this.createWorker(i, workerScript));
        }

        const workers = await Promise.all(promises);

        CSReporter.info(`[Perf] All workers ready in ${Date.now() - startTime}ms`);

        // Store workers and start assigning work
        workers.forEach(worker => {
            this.workers.set(worker.id, worker);
            this.workerPool.push(worker);
            // Assign work immediately
            setImmediate(() => this.assignWork(worker));
        });
    }

    private createWorker(id: number, script: string): Promise<Worker> {
        return new Promise((resolve, reject) => {
            const project = this.config.get('PROJECT') || this.config.get('project') || 'common';

            // Get decrypted ADO configuration values from main process
            const adoConfig: Record<string, string> = {};
            const adoKeys = [
                'ADO_PAT', 'ADO_ORGANIZATION', 'ADO_PROJECT',
                'ADO_BASE_URL', 'ADO_API_VERSION', 'ADO_PLAN_ID',
                'ADO_SUITE_ID', 'ADO_TEST_PLAN_ID', 'ADO_TEST_SUITE_ID',
                'ADO_ENABLED', 'ADO_DRY_RUN'
            ];

            // Get decrypted values from config manager
            for (const key of adoKeys) {
                const value = this.config.get(key);
                if (value) {
                    adoConfig[key] = value;
                }
            }

            // Pass artifact-related configuration to workers
            const artifactConfig: Record<string, string> = {};
            const artifactKeys = [
                'BROWSER_VIDEO', 'BROWSER_VIDEO_WIDTH', 'BROWSER_VIDEO_HEIGHT',
                'HAR_CAPTURE_MODE', 'BROWSER_HAR_ENABLED', 'BROWSER_HAR_OMIT_CONTENT',
                'TRACE_CAPTURE_MODE', 'BROWSER_TRACE_ENABLED',
                'SCREENSHOT_CAPTURE_MODE', 'SCREENSHOT_ON_FAILURE',
                'HEADLESS', 'BROWSER', 'TIMEOUT'
            ];

            // Get artifact configuration values from config manager
            for (const key of artifactKeys) {
                const value = this.config.get(key);
                if (value !== undefined && value !== null) {
                    artifactConfig[key] = String(value);
                }
            }

            // Optimize fork options for better performance
            // Only use ts-node for TypeScript files
            const isTypeScript = script.endsWith('.ts');

            // Get worker heap size from config (default 1024MB)
            const workerHeapSize = this.config.getNumber('WORKER_HEAP_SIZE', 1024);

            const execArgv = isTypeScript ? [
                '-r', 'ts-node/register',
                `--max-old-space-size=${workerHeapSize}`, // Configurable memory per worker
                '--no-warnings' // Suppress warnings for cleaner output
            ] : [
                `--max-old-space-size=${workerHeapSize}`, // Configurable memory per worker
                '--no-warnings' // Suppress warnings for cleaner output
            ];

            const workerProcess = fork(script, [], {
                execArgv,
                env: {
                    ...process.env,  // Base environment variables
                    ...adoConfig,    // Override with decrypted ADO values
                    ...artifactConfig, // Pass artifact configuration
                    WORKER_ID: String(id),
                    TS_NODE_TRANSPILE_ONLY: 'true',
                    TS_NODE_FILES: 'false', // Don't type check
                    TS_NODE_CACHE: 'true', // Enable caching
                    TS_NODE_COMPILER_OPTIONS: JSON.stringify({
                        module: 'commonjs',
                        target: 'es2017',
                        esModuleInterop: true,
                        skipLibCheck: true,
                        experimentalDecorators: true,
                        emitDecoratorMetadata: true
                    }),
                    NODE_ENV: 'production', // Optimize for production
                    PROJECT: project,  // Pass project for early step loading
                    LAZY_LOAD: 'true', // Enable lazy loading in worker
                    TEST_RESULTS_DIR: this.resultsManager.getCurrentTestRunDir() // Pass parent test results directory
                },
                silent: false,
                serialization: 'advanced' // Use V8 serialization for better IPC performance
            });

            const worker: Worker = {
                id,
                process: workerProcess,
                busy: false
            };

            workerProcess.on('message', (message: any) => {
                this.handleWorkerMessage(worker, message);
            });

            workerProcess.on('error', (error) => {
                CSReporter.error(`Worker ${id} error: ${error.message}`);
                reject(error);
            });

            workerProcess.on('exit', (code) => {
                if (code !== 0 && code !== null) {
                    CSReporter.warn(`Worker ${id} exited with code ${code}`);
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

            // Reduced timeout since workers now start faster
            setTimeout(() => {
                reject(new Error(`Worker ${id} failed to start`));
            }, 10000);
        });
    }

    private handleWorkerMessage(worker: Worker, message: any) {
        switch (message.type) {
            case 'result':
                this.handleResult(worker, message);
                break;
            case 'error':
                CSReporter.error(`Worker ${worker.id} error: ${message.error}`);
                this.handleWorkerError(worker, message);
                break;
            case 'log':
                if (this.config.getBoolean('DEBUG_WORKERS', false)) {
                    CSReporter.debug(`[Worker ${worker.id}] ${message.message}`);
                }
                break;
            case 'metrics':
                this.performanceMetrics.set(`worker-${worker.id}`, message.metrics);
                break;
        }
    }

    private handleWorkerError(worker: Worker, error: any) {
        // Track error for worker health monitoring
        if (!worker.errorCount) {
            worker.errorCount = 0;
        }
        worker.errorCount++;

        // If worker has too many errors, consider recycling it
        if (worker.errorCount > 5 && this.reuseWorkers) {
            CSReporter.warn(`Worker ${worker.id} has ${worker.errorCount} errors, recycling...`);
            this.recycleWorker(worker);
        }
    }

    private async recycleWorker(worker: Worker) {
        // Remove from pool
        this.workers.delete(worker.id);
        const poolIndex = this.workerPool.indexOf(worker);
        if (poolIndex > -1) {
            this.workerPool.splice(poolIndex, 1);
        }

        // Kill the problematic worker
        try {
            worker.process.kill();
        } catch (e) {
            // Ignore
        }

        // Create replacement worker with correct extension
        const ext = __filename.endsWith('.ts') ? '.ts' : '.js';
        const newWorker = await this.createWorker(worker.id, path.join(__dirname, `worker-process${ext}`));
        this.workers.set(newWorker.id, newWorker);
        this.workerPool.push(newWorker);

        // Assign pending work if any
        if (worker.currentWork) {
            this.workQueue.unshift(worker.currentWork); // Re-queue the work
        }
        this.assignWork(newWorker);
    }

    private async handleResult(worker: Worker, result: any) {
        if (worker.currentWork) {
            const work = worker.currentWork;

            this.results.set(work.id, {
                scenarioName: result.name || work.scenario.name,  // Use the interpolated name from worker if available
                featureName: work.feature.name,
                workerId: worker.id,  // Add worker ID for timeline
                ...result
            });

            // DEBUG: Log work item properties
            CSReporter.debug(`[Orchestrator] handleResult for: ${work.scenario.name}, iterationNumber=${work.iterationNumber}, totalIterations=${work.totalIterations}`);

            // Handle data-driven test aggregation
            if (work.iterationNumber && work.totalIterations) {
                // This is a data-driven test iteration
                const baseScenarioName = work.scenario.name.replace(/_Iteration-\d+$/, '');
                const scenarioKey = `${work.feature.name}::${baseScenarioName}`;

                CSReporter.debug(`Data-driven iteration ${work.iterationNumber}/${work.totalIterations} for ${scenarioKey}`);

                if (!this.dataDrivenResults.has(scenarioKey)) {
                    this.dataDrivenResults.set(scenarioKey, []);
                }

                const iterations = this.dataDrivenResults.get(scenarioKey)!;

                // Use testData from result if available, otherwise build from work item
                const iterationData = result.testData ||
                    (work.exampleRow ?
                        Object.fromEntries(work.exampleHeaders?.map((h, i) => [h, work.exampleRow![i]]) || []) :
                        undefined);

                CSReporter.debug(`Iteration data for iteration ${work.iterationNumber}: ${JSON.stringify(iterationData)}`);

                iterations.push({
                    iteration: work.iterationNumber,
                    status: result.status,
                    duration: result.duration,
                    errorMessage: result.error,
                    stackTrace: result.stackTrace,
                    iterationData: iterationData
                });

                // Check if all iterations for this scenario are complete
                if (iterations.length === work.totalIterations) {
                    CSReporter.info(`All ${work.totalIterations} iterations complete for ${baseScenarioName}. Publishing aggregated result to ADO...`);
                    // All iterations complete, publish aggregated result to ADO
                    await this.publishAggregatedResult(scenarioKey, work, iterations);
                } else {
                    CSReporter.debug(`Waiting for more iterations: ${iterations.length}/${work.totalIterations} complete`);
                }
            } else {
                // Regular scenario or single test - publish immediately
                if (result.adoMetadata && this.adoIntegration?.isEnabled()) {
                    const status = result.status === 'passed' ? 'passed' :
                                  result.status === 'failed' ? 'failed' : 'skipped';

                    await this.adoIntegration.afterScenario(
                        work.scenario,
                        work.feature,
                        status,
                        result.duration,
                        result.error,
                        result.artifacts,
                        result.stackTrace, // Pass stack trace for failed tests
                        undefined, // iterationNumber
                        undefined  // iterationData
                    );
                }
            }

            this.completedCount++;

            const statusSymbol = result.status === 'passed' ? '✓' : '✗';
            CSReporter.info(
                `[${this.completedCount}/${this.totalCount}] ${statusSymbol} ${work.scenario.name} (${result.duration}ms)`
            );

            worker.busy = false;
            worker.currentWork = undefined;

            // Assign next work
            this.assignWork(worker);
        }
    }

    private async publishAggregatedResult(scenarioKey: string, work: WorkItem, iterations: any[]) {
        if (!this.adoIntegration?.isEnabled()) {
            CSReporter.debug(`ADO integration not enabled, skipping aggregated publish`);
            return;
        }

        CSReporter.info(`Publishing aggregated ADO result for ${scenarioKey} with ${iterations.length} iterations`);

        // Sort iterations by iteration number
        iterations.sort((a, b) => a.iteration - b.iteration);

        // Determine overall outcome
        const hasFailure = iterations.some(iter => iter.status === 'failed');
        const overallOutcome = hasFailure ? 'Failed' : 'Passed';

        // Calculate pass/fail counts
        const passedCount = iterations.filter(iter => iter.status === 'passed').length;
        const failedCount = iterations.filter(iter => iter.status === 'failed').length;

        // Build detailed summary for all iterations
        const iterationSummaries: string[] = [];
        const failedIterations: number[] = [];
        let totalDuration = 0;
        let firstStackTrace: string | undefined;
        let firstErrorMessage: string | undefined;

        for (const iter of iterations) {
            totalDuration += iter.duration || 0;

            if (iter.status === 'failed') {
                failedIterations.push(iter.iteration);

                // Keep the first error and stack trace
                if (!firstErrorMessage && iter.errorMessage) {
                    firstErrorMessage = iter.errorMessage;
                }
                if (!firstStackTrace && iter.stackTrace) {
                    firstStackTrace = iter.stackTrace;
                }

                // For detailed summary (only if we have space)
                if (iterations.length <= 10) {
                    let iterSummary = `Iteration ${iter.iteration}`;
                    if (iter.iterationData) {
                        const params = Object.entries(iter.iterationData)
                            .slice(0, 3) // Limit to first 3 params to save space
                            .map(([key, value]) => `${key}=${value}`)
                            .join(', ');
                        iterSummary += ` [${params}]`;
                    }
                    iterSummary += `: ❌ Failed`;
                    if (iter.errorMessage) {
                        // Truncate error message if too long
                        const errorMsg = iter.errorMessage.length > 50
                            ? iter.errorMessage.substring(0, 47) + '...'
                            : iter.errorMessage;
                        iterSummary += ` - ${errorMsg}`;
                    }
                    iterationSummaries.push(iterSummary);
                }
            }
        }

        // Build comprehensive comment (limited to 1000 chars for ADO)
        let comment = '';

        // Simple clean format for parallel execution
        const iterationLines: string[] = [];

        for (const [idx, iter] of iterations.entries()) {
            const iterNum = iter.iteration || idx + 1;
            if (iter.status === 'passed') {
                iterationLines.push(`Iteration-${iterNum} ✅ Passed`);
            } else {
                // Extract short error message
                let shortError = '';
                if (iter.errorMessage) {
                    if (iter.errorMessage.includes('Element not found')) {
                        shortError = ' [Error: Element not found]';
                    } else if (iter.errorMessage.includes('Step definition not found')) {
                        shortError = ' [Error: Missing step]';
                    } else if (iter.errorMessage.includes('Timeout')) {
                        shortError = ' [Error: Timeout]';
                    } else {
                        // Take first 30 chars of error
                        shortError = ` [Error: ${iter.errorMessage.substring(0, 30)}]`;
                    }
                }
                iterationLines.push(`Iteration-${iterNum} ❌ Failed${shortError}`);
            }
        }

        // Build simple comment
        comment = `Data-Driven Test Results (${iterations.length} iterations)\n` +
                 `Overall Status: ${overallOutcome}\n\n` +
                 iterationLines.join('\n');

        // Truncate to 1000 characters if needed
        if (comment.length > 1000) {
            comment = comment.substring(0, 997) + '...';
        }

        // Create aggregated error message if there are failures
        const aggregatedError = failedCount > 0 ?
            `${failedCount} of ${iterations.length} iterations failed. See comment for details.` :
            undefined;

        // Use the original scenario name without iteration suffix
        const baseScenario = { ...work.scenario };
        baseScenario.name = work.scenario.name.replace(/_Iteration-\d+$/, '');

        CSReporter.info(`Aggregated ADO comment (${comment.length} chars):\n${comment}`);
        CSReporter.debug(`Aggregated error message: ${aggregatedError || 'none'}`);

        // Publish aggregated result
        await this.adoIntegration.afterScenario(
            baseScenario,
            work.feature,
            hasFailure ? 'failed' : 'passed',
            totalDuration,
            aggregatedError,
            {}, // artifacts - could be aggregated from iterations
            firstStackTrace, // pass the first stack trace from failed iterations
            undefined, // no iterationNumber for aggregated result
            undefined, // no iterationData for aggregated result
            comment // pass the detailed comment
        );

        CSReporter.info(`📊 Published aggregated result for ${baseScenario.name}: ${overallOutcome} (${iterations.length} iterations, ${totalDuration}ms total)`);
    }

    private assignWork(worker: Worker) {
        if (worker.busy || this.workQueue.length === 0) {
            return;
        }

        const work = this.workQueue.shift()!;
        worker.busy = true;
        worker.currentWork = work;
        worker.assignedAt = Date.now(); // Track assignment time for timeout detection

        // Only send necessary config, not everything
        const essentialConfig = this.getEssentialConfig();

        worker.process.send({
            type: 'execute',
            scenarioId: work.id,
            feature: work.feature,
            scenario: work.scenario,
            config: essentialConfig,
            exampleRow: work.exampleRow,
            exampleHeaders: work.exampleHeaders,
            iterationNumber: work.iterationNumber,
            totalIterations: work.totalIterations,
            testResultsDir: this.resultsManager.getCurrentTestRunDir() // Pass test results directory
        });

        if (this.config.getBoolean('DEBUG_WORKERS', false)) {
            CSReporter.debug(`Worker ${worker.id} assigned: ${work.scenario.name}`);
        }
    }

    private getEssentialConfig(): Record<string, any> {
        // PERFORMANCE: Send only config manager values, not all env vars
        //Sending all env vars was causing huge IPC overhead
        const config: Record<string, any> = {};

        //Get all config from config manager (returns Map<string, string>)
        const allConfigMap = this.config.getAll();

        //Convert Map to plain object for IPC serialization
        for(const [key, value] of allConfigMap.entries()) {
            if(value !== undefined && value !== null) {
                config[key] = value;
            }
        }

        //Only add essential env vars that might not be in config
        //but are commonly used in test scenarios
        const essentialEnvVars = [
            'NODE_ENV', 'CI', 'BUILD_ID', 'BUILD_NUMBER',
            'TEST_ENV', 'ENVIRONMENT', 'REGION'
        ];

        for( const envKey of essentialEnvVars) {
            if(process.env[envKey] && !config[envKey]) {
                config[envKey] = process.env[envKey];
            }
        }

        return config;
    }

    private waitForCompletion(): Promise<void> {
        return new Promise((resolve) => {
            const startTime = Date.now();
            const checkInterval = setInterval(() => {
                if (this.completedCount >= this.totalCount) {
                    clearInterval(checkInterval);
                    const totalTime = Date.now() - startTime;
                    CSReporter.info(`[Perf] All tests completed in ${totalTime}ms`);
                    this.printPerformanceReport();
                    resolve();
                }

                // Check for stuck workers with better timeout detection
                const now = Date.now();
                for (const worker of this.workers.values()) {
                    if (!worker.process.connected && worker.busy) {
                        CSReporter.warn(`Worker ${worker.id} disconnected while busy`);
                        worker.busy = false;
                        this.completedCount++;
                        // Re-queue the work
                        if (worker.currentWork) {
                            this.workQueue.push(worker.currentWork);
                            this.assignWorkToIdleWorker();
                        }
                    } else if (worker.busy && worker.assignedAt) {
                        // Check for timeout (2 minutes per scenario)
                        const elapsed = now - worker.assignedAt;
                        if (elapsed > 120000) {
                            CSReporter.warn(`Worker ${worker.id} timeout on: ${worker.currentWork?.scenario.name}`);
                            // Recycle the worker
                            this.recycleWorker(worker);
                        }
                    }
                }
            }, 100);

            // Timeout after 10 minutes (increased for large test suites)
            setTimeout(() => {
                clearInterval(checkInterval);
                CSReporter.warn('Parallel execution timed out');
                this.printPerformanceReport();
                resolve();
            }, 600000);
        });
    }

    private assignWorkToIdleWorker() {
        // Find an idle worker and assign work
        for (const worker of this.workers.values()) {
            if (!worker.busy) {
                this.assignWork(worker);
                break;
            }
        }
    }

    private printPerformanceReport() {
        if (this.performanceMetrics.size > 0) {
            CSReporter.info('=== Performance Report ===');
            for (const [key, metrics] of this.performanceMetrics) {
                CSReporter.info(`${key}: ${JSON.stringify(metrics)}`);
            }
        }
    }

    private async cleanup() {
        CSReporter.info('[Perf] Cleaning up workers...');
        const cleanupStart = Date.now();

        // Send terminate message to all workers
        const terminationPromises: Promise<void>[] = [];

        for (const worker of this.workers.values()) {
            try {
                const terminationPromise = new Promise<void>((resolve) => {
                    // Set up a timeout in case worker doesn't exit cleanly
                    const timeout = setTimeout(() => {
                        if (worker.process.connected) {
                            CSReporter.warn(`Worker ${worker.id} did not exit gracefully, force killing...`);
                            worker.process.kill('SIGKILL'); // Force kill if needed
                        }
                        resolve();
                    }, 20000); // Increased to 20s to allow HAR saving (context close can take up to 15s)

                    // Listen for worker exit
                    worker.process.once('exit', () => {
                        clearTimeout(timeout);
                        resolve();
                    });

                    // Send terminate message
                    if (worker.process.connected) {
                        worker.process.send({ type: 'terminate' });
                    } else {
                        resolve();
                    }
                });

                terminationPromises.push(terminationPromise);
            } catch (e) {
                // Ignore errors during cleanup
            }
        }

        // Wait for all workers to terminate
        await Promise.all(terminationPromises);
        this.workers.clear();
        this.workerPool = [];

        CSReporter.info(`[Perf] Cleanup completed in ${Date.now() - cleanupStart}ms`);
    }
}