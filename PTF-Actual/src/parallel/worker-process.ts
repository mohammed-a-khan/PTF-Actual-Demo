#!/usr/bin/env node
/**
 * Optimized Worker Process for Parallel Test Execution
 * Performance optimizations:
 * - Module preloading and caching
 * - Lazy initialization
 * - Reduced require() calls
 * - Configuration caching
 */

// Register ts-node with decorator support BEFORE any other imports
// This ensures TypeScript step definitions can be loaded properly
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
        // ts-node already registered by parent process
    }
}

import * as path from 'path';

// Message types for IPC
interface ExecuteMessage {
    type: 'execute';
    scenarioId: string;
    feature: any;
    scenario: any;
    config: Record<string, any>;
    exampleRow?: string[];
    exampleHeaders?: string[];
    iterationNumber?: number;
    totalIterations?: number;
    testResultsDir?: string; // Parent test results directory
}

interface ResultMessage {
    type: 'result';
    scenarioId: string;
    name?: string;  // Add scenario name (interpolated with iteration)
    status: 'passed' | 'failed' | 'skipped';
    duration: number;
    error?: string;
    stackTrace?: string;
    steps: any[];
    artifacts: {
        screenshots: string[];
        videos: string[];
        traces?: string[];
        har?: string[];
        logs?: string[];
    };
    tags?: string[];
    startTime?: Date;
    endTime?: Date;
    testData?: any;  // Add test data for data-driven scenarios
    adoMetadata?: any;  // ADO metadata for test case mapping
    iteration?: number;  // Iteration number for data-driven scenarios
    iterationData?: any;  // Iteration data (example row as object)
}

// Module cache for performance
const moduleCache: Map<string, any> = new Map();

class WorkerProcess {
    private workerId: number;
    private bddRunner: any;
    private browserManager: any;
    private scenarioCountForReuse: number = 0;
    private anyTestFailed: boolean = false;  // Track if any test failed for HAR decision
    private adoIntegration: any;
    private configManager: any;
    private isInitialized: boolean = false;
    private stepDefinitionsLoaded: Map<string, boolean> = new Map();
    private frameworkStepsLoaded: boolean = false; // NEW: Track if framework steps are loaded
    private performanceMetrics: Map<string, number> = new Map();

    constructor() {
        this.workerId = parseInt(process.env.WORKER_ID || '0');
        process.env.IS_WORKER = 'true';
        process.env.WORKER_ID = String(this.workerId);

        // Enable performance optimizations
        process.env.NODE_ENV = process.env.NODE_ENV || 'production';
        process.env.TS_NODE_TRANSPILE_ONLY = 'true';
        process.env.TS_NODE_FILES = 'false';

        this.setupProcessHandlers();

        // Send ready immediately
        this.sendReady();

        // Preload critical modules in background for faster first scenario
        setImmediate(() => this.preloadModules());
    }

    private sendReady() {
        // Send ready immediately without waiting for module loading
        setImmediate(() => {
            this.sendMessage({ type: 'ready', workerId: this.workerId });
        });
    }

    private async preloadModules() {
        // Preload critical modules AND initialize them immediately for faster first scenario
        try {
            const modules = [
                '../bdd/CSBDDRunner',
                '../core/CSConfigurationManager',
                '../browser/CSBrowserManager',
                '../ado/CSADOIntegration'
            ];

            for (const module of modules) {
                this.getModule(module);
            }

            // Initialize singletons immediately to avoid delay on first scenario
            await this.lazyInitialize();
        } catch (e: any) {
            console.debug(`[Worker ${this.workerId}] Preload warning:`, e.message);
        }
    }

    private getModule(moduleName: string): any {
        if (!moduleCache.has(moduleName)) {
            const startTime = Date.now();
            moduleCache.set(moduleName, require(moduleName));
            this.performanceMetrics.set(moduleName, Date.now() - startTime);
        }
        return moduleCache.get(moduleName);
    }


    private async lazyInitialize() {
        if (this.isInitialized) return;

        const startTime = Date.now();

        try {
            // Always load core modules
            const { CSBDDRunner } = this.getModule('../bdd/CSBDDRunner');
            const { CSConfigurationManager } = this.getModule('../core/CSConfigurationManager');

            this.bddRunner = CSBDDRunner.getInstance();
            this.configManager = CSConfigurationManager.getInstance();

            // CRITICAL: Initialize configuration to load config files
            // This ensures STEP_DEFINITIONS_PATH and other config values are loaded
            const project = process.env.PROJECT || 'common';
            await this.configManager.initialize({project});

            // Browser manager will be loaded conditionally during test execution
            this.browserManager = null;

            this.isInitialized = true;

            this.sendMessage({
                type: 'log',
                message: `Core modules initialized in ${Date.now() - startTime}ms`
            });
        } catch (error) {
            console.error(`[Worker ${this.workerId}] Failed to initialize:`, error);
            throw error;
        }
    }

    private async initializeBrowserIfNeeded(feature: any, scenario: any) {
        // Use the same logic as sequential execution: check BROWSER_LAUNCH_REQUIRED config
        const browserLaunchRequired = this.configManager.getBoolean('BROWSER_LAUNCH_REQUIRED', true);

        if (!browserLaunchRequired) {
            console.log(`[Worker ${this.workerId}] Browser launch disabled by BROWSER_LAUNCH_REQUIRED=false (API test)`);
            return; // Browser not needed for API tests
        }

        if (this.browserManager) {
            return; // Already initialized
        }

        try {
            console.log(`[Worker ${this.workerId}] Initializing browser for UI test...`);
            const { CSBrowserManager } = this.getModule('../browser/CSBrowserManager');
            this.browserManager = CSBrowserManager.getInstance();
            console.log(`[Worker ${this.workerId}] Browser manager initialized`);
        } catch (error) {
            console.error(`[Worker ${this.workerId}] Failed to initialize browser manager:`, error);
            throw error;
        }
    }

    private setupProcessHandlers() {
        process.on('message', this.handleMessage.bind(this));
        process.on('SIGTERM', this.cleanup.bind(this));
        process.on('SIGINT', this.cleanup.bind(this));
        process.on('uncaughtException', (error) => {
            console.error(`[Worker ${this.workerId}] Uncaught exception:`, error);
            this.cleanup();
        });

        // Playwright 1.57+ inspired: Capture console events from worker process
        this.setupConsoleCapture();
    }

    // ============================================
    // WORKER CONSOLE CAPTURE (Playwright 1.57+ inspired)
    // ============================================

    private consoleMessages: Array<{type: string, message: string, timestamp: number}> = [];
    private consoleCapureEnabled: boolean = false;

    /**
     * Setup console capture for worker process
     * Inspired by Playwright 1.57's worker.on('console') feature
     */
    private setupConsoleCapture() {
        // Check if console capture is enabled via config (default: true in debug mode)
        const enableCapture = process.env.WORKER_CONSOLE_CAPTURE === 'true' ||
                             process.env.LOG_LEVEL === 'debug' ||
                             process.env.DEBUG === 'true';

        if (!enableCapture) return;

        this.consoleCapureEnabled = true;

        // Capture console.log
        const originalLog = console.log;
        console.log = (...args: any[]) => {
            this.captureConsole('log', args);
            originalLog.apply(console, args);
        };

        // Capture console.error
        const originalError = console.error;
        console.error = (...args: any[]) => {
            this.captureConsole('error', args);
            originalError.apply(console, args);
        };

        // Capture console.warn
        const originalWarn = console.warn;
        console.warn = (...args: any[]) => {
            this.captureConsole('warn', args);
            originalWarn.apply(console, args);
        };

        // Capture console.info
        const originalInfo = console.info;
        console.info = (...args: any[]) => {
            this.captureConsole('info', args);
            originalInfo.apply(console, args);
        };

        // Capture console.debug
        const originalDebug = console.debug;
        console.debug = (...args: any[]) => {
            this.captureConsole('debug', args);
            originalDebug.apply(console, args);
        };
    }

    /**
     * Capture a console message
     */
    private captureConsole(type: string, args: any[]) {
        if (!this.consoleCapureEnabled) return;

        const message = args.map(arg => {
            if (typeof arg === 'object') {
                try {
                    return JSON.stringify(arg);
                } catch {
                    return String(arg);
                }
            }
            return String(arg);
        }).join(' ');

        // Store message (limit to last 100 messages to avoid memory issues)
        this.consoleMessages.push({
            type,
            message,
            timestamp: Date.now()
        });

        if (this.consoleMessages.length > 100) {
            this.consoleMessages.shift();
        }

        // Send console message to parent process if it's an error or warning
        if (type === 'error' || type === 'warn') {
            this.sendMessage({
                type: 'console',
                workerId: this.workerId,
                consoleType: type,
                message: message,
                timestamp: Date.now()
            });
        }
    }

    /**
     * Get captured console messages for this worker
     */
    public getConsoleMessages(): Array<{type: string, message: string, timestamp: number}> {
        return [...this.consoleMessages];
    }

    /**
     * Clear captured console messages
     */
    public clearConsoleMessages(): void {
        this.consoleMessages = [];
    }

    private async handleMessage(message: any) {
        switch (message.type) {
            case 'init':
                // Handle initialization data from orchestrator
                // Skip preloading - steps will be loaded during execution
                break;
            case 'execute':
                await this.executeScenario(message as ExecuteMessage);
                break;
            case 'terminate':
                await this.cleanup();
                process.exit(0);
                break;
        }
    }

    private async executeScenario(message: ExecuteMessage) {
        const startTime = Date.now();
        const result: ResultMessage = {
            type: 'result',
            scenarioId: message.scenarioId,
            status: 'failed',
            duration: 0,
            steps: [],
            artifacts: {
                screenshots: [],
                videos: []
            }
        };

        let scenarioResult: any = null;  // Declare here so it's accessible in finally block

        try {
            // Lazy initialize if not done
            await this.lazyInitialize();

            //PERFORMANCE FIX: Only update config if project changes or first scenario
            const newProject = message.config.project || message.config.PROJECT;
            const isFirstScenario = !this.frameworkStepsLoaded;
            const projectChanged = process.env.PROJECT !== newProject

            if (projectChanged || isFirstScenario) {
                if (projectChanged) {
                    process.env.PROJECT = newProject;
                    await this.configManager.initialize({project: newProject});
                }

            //Apply message config (only on first scenario or project change)
            for (const [key, value] of Object.entries(message.config)) {
                this.configManager.set(key, value);
            }

                console.log(`[Worker ${this.workerId}] Configuration updated (project: ${process.env.PROJECT})`);
            }

            // Set test results directory from parent if provided
            if (message.testResultsDir) {
                process.env.TEST_RESULTS_DIR = message.testResultsDir;
                this.configManager.set('TEST_RESULTS_DIR', message.testResultsDir);
            } else if (process.env.TEST_RESULTS_DIR) {
                this.configManager.set('TEST_RESULTS_DIR', process.env.TEST_RESULTS_DIR);
            }

            // Initialize ADO only once if enabled
            const adoEnabled = this.configManager.get('ADO_ENABLED') === 'true' ||
                             this.configManager.get('ADO_INTEGRATION_ENABLED') === 'true';

            if (adoEnabled && !this.adoIntegration) {
                const { CSADOIntegration } = this.getModule('../ado/CSADOIntegration');
                this.adoIntegration = CSADOIntegration.getInstance();
                await this.adoIntegration.initialize(true); // true for worker mode
            }

            // INTELLIGENT MODULE DETECTION & SELECTIVE STEP LOADING (Worker Mode)
            const projectKey = message.config.project || message.config.PROJECT || 'default';

            //PERFORMANCE FIX: Only load steps ONCE per worker, not every scenario!
            const needsStepLoading = !this.frameworkStepsLoaded || !this.stepDefinitionsLoaded.get(projectKey);

            if (needsStepLoading) {
                const stepLoadStart = Date.now();

            // Check if intelligent module detection is enabled (default: true)
            const moduleDetectionEnabled = this.configManager.getBoolean('MODULE_DETECTION_ENABLED', true);

                //store requirements outside the block so it can be used for project steps loading
                let requirements: any;

                if(moduleDetectionEnabled && !this.frameworkStepsLoaded) {
                    //Load module detection components
                    const { CSModuleDetector } = this.getModule('../core/CSModuleDetector');
                    const { CSStepLoader } = this.getModule('../core/CSStepLoader');

                // Check if user explicitly specified modules via --modules flag
                const explicitModules = this.configManager.get('MODULES') || message.config.MODULES;

                if (explicitModules) {
                    // User explicitly specified modules - override auto-detection
                    const moduleList = explicitModules.split(',').map((m: string) => m.trim().toLowerCase());
                    requirements = {
                        browser: moduleList.includes('ui') || moduleList.includes('browser'),
                        api: moduleList.includes('api'),
                        database: moduleList.includes('database') || moduleList.includes('db'),
                        soap: moduleList.includes('soap')
                    };
                    console.log(`[Worker ${this.workerId}] Explicit modules specified: ${explicitModules}`);
                } else {
                    // Auto-detect required modules from scenario content
                    const moduleDetector = CSModuleDetector.getInstance();
                    requirements = moduleDetector.detectRequirements(message.scenario, message.feature);
                }

                //Load only required framework step definitions (ONCE per worker)
                const stepLoader = CSStepLoader.getInstance();
                await stepLoader.loadRequiredSteps(requirements);

                this.frameworkStepsLoaded = true; //Mark as loaded
                console.log(`[Worker ${this.workerId}] Framework steps loaded`);

                // Log if enabled
                if (this.configManager.getBoolean('MODULE_DETECTION_LOGGING', false)) {
                    const moduleDetector = CSModuleDetector.getInstance();
                    const modules = moduleDetector.getRequirementsSummary(requirements);
                    console.log(`[Worker ${this.workerId}] Module Detection: ${modules}`);
                }
            }

            //Load project-specific step definitions (ONCE per project per worker)
            if(!this.stepDefinitionsLoaded.get(projectKey)) {
                await this.bddRunner.loadProjectSteps(projectKey, requirements);
                this.stepDefinitionsLoaded.set(projectKey, true);
                console.log(`[Worker ${this.workerId}] Project-specific steps loaded for: ${projectKey}`);
            }

            this.performanceMetrics.set(`steps-$projectKey}`, Date.now() - stepLoadStart);

        } else {
            //steps already loaded - skip!
            console.log(`[Worker ${this.workerId}] Skipping step loading - already loaded`);
        }

            // Execute the scenario using the existing framework method
            // This will handle browser, context, steps, everything
            // Pass data-driven test parameters if provided
            scenarioResult = await this.bddRunner.executeSingleScenarioForWorker(
                message.scenario,
                message.feature,
                { failFast: false },
                message.exampleRow,
                message.exampleHeaders,
                message.iterationNumber,
                message.totalIterations
            );

            // Map the result including all data from the scenario
            result.name = scenarioResult.name;  // Pass the interpolated scenario name
            result.status = scenarioResult.status;
            result.steps = scenarioResult.steps;
            // Don't use artifacts from scenarioResult yet - will collect after browser handling
            result.tags = scenarioResult.tags || [];  // Pass tags back
            result.startTime = scenarioResult.startTime;
            result.endTime = scenarioResult.endTime;
            result.testData = scenarioResult.testData;  // Pass test data for data-driven scenarios

            // Pass iteration information for data-driven scenarios
            if (message.iterationNumber !== undefined) {
                result.iteration = message.iterationNumber;
            }
            if (message.exampleRow && message.exampleHeaders) {
                result.iterationData = {};
                message.exampleHeaders.forEach((header, index) => {
                    if (message.exampleRow) {
                        result.iterationData[header] = message.exampleRow[index];
                    }
                });
            }

            // Capture error and stack trace for failed tests
            if (result.status === 'failed') {
                result.error = scenarioResult.error;
                result.stackTrace = scenarioResult.stackTrace;
            }

            // Track if any test failed for HAR decision
            if (result.status === 'failed') {
                this.anyTestFailed = true;
            }

            // Capture console logs only if needed
            if (this.configManager.getBoolean('CAPTURE_CONSOLE_LOGS', false)) {
                const { CSParallelMediaHandler } = this.getModule('../parallel/CSParallelMediaHandler');
                const mediaHandler = CSParallelMediaHandler.getInstance();
                const logPath = await mediaHandler.saveConsoleLogs(message.scenario.name);
                if (logPath) {
                    result.artifacts = result.artifacts || { screenshots: [], videos: [] };
                    result.artifacts.logs = [logPath];
                }
            }

            // Extract ADO metadata if integration is enabled
            if (this.configManager.getBoolean('ADO_INTEGRATION_ENABLED', false)) {
                const { CSADOTagExtractor } = this.getModule('../ado/CSADOTagExtractor');
                const tagExtractor = CSADOTagExtractor.getInstance();
                const adoMetadata = tagExtractor.extractMetadata(message.scenario, message.feature);
                result.adoMetadata = adoMetadata;
            }

        } catch (error: any) {
            console.error(`[Worker ${this.workerId}] Error:`, error);
            result.status = 'failed';
            result.error = error.message;
            result.stackTrace = error.stack;
        } finally {
            // Handle browser reuse or close based on configuration
            try {
                if (this.browserManager) {
                    const browserReuseEnabled = this.configManager.getBoolean('BROWSER_REUSE_ENABLED', false);
                    const clearStateOnReuse = this.configManager.getBoolean('BROWSER_REUSE_CLEAR_STATE', true);
                    const closeAfterScenarios = this.configManager.getNumber('BROWSER_REUSE_CLOSE_AFTER_SCENARIOS', 0);

                    if (browserReuseEnabled) {
                        // Track scenario count for periodic browser restart
                        if (!this.scenarioCountForReuse) {
                            this.scenarioCountForReuse = 0;
                        }
                        this.scenarioCountForReuse++;

                        // Check if we should close browser after N scenarios
                        const shouldCloseBrowser = closeAfterScenarios > 0 &&
                                                 this.scenarioCountForReuse >= closeAfterScenarios;

                        if (shouldCloseBrowser) {
                            // Close and reset counter
                            console.log(`[Worker ${this.workerId}] Closing browser after ${this.scenarioCountForReuse} scenarios`);
                            await this.browserManager.close(result.status);
                            this.scenarioCountForReuse = 0;
                        } else {
                            // Keep browser open but clear state if configured
                            // Note: Trace saving is already handled by CSBDDRunner.executeSingleScenarioForWorker
                            // so we don't need to save it here to avoid duplicates
                            if (clearStateOnReuse) {
                                try {
                                    const context = this.browserManager.getContext();
                                    const page = this.browserManager.getPage();

                                    if (page && context) {
                                        // Step 1: Navigate to about:blank first to leave the application
                                        await page.goto('about:blank');

                                        // Step 2: Clear all cookies at context level
                                        await context.clearCookies();

                                        // Step 3: Clear permissions
                                        await context.clearPermissions();

                                        // Step 4: Clear localStorage and sessionStorage via JavaScript
                                        await page.evaluate(() => {
                                            try {
                                                localStorage.clear();
                                                sessionStorage.clear();
                                            } catch (e) {
                                                // Ignore errors on about:blank
                                            }
                                        });

                                        // Step 5: Clear the saved browser state to prevent restoration
                                        this.browserManager.clearBrowserState();

                                        console.log(`[Worker ${this.workerId}] Browser state completely cleared for reuse`);
                                    }
                                } catch (e) {
                                    console.debug(`[Worker ${this.workerId}] Failed to clear browser state: ${e}`);
                                }
                            } else {
                                console.log(`[Worker ${this.workerId}] Browser kept open for reuse (state not cleared)`);
                            }

                            // Restart trace recording for the next scenario (after state is cleared)
                            await (this.browserManager as any).restartTraceForNextScenario?.();
                        }
                    } else {
                        // Default behavior - close browser after each scenario
                        await this.browserManager.close(result.status);
                        console.log(`[Worker ${this.workerId}] Browser closed with status: ${result.status}`);
                    }
                }
            } catch (e) {
                // Ignore cleanup errors
                console.debug(`[Worker ${this.workerId}] Error during browser cleanup: ${e}`);
            }

            // NOW collect artifacts after browser operations (close/clear) are complete
            // This ensures video, HAR, and trace files are properly saved
            if (this.browserManager) {
                try {
                    console.log(`[Worker ${this.workerId}] Collecting artifacts after browser operations...`);
                    const artifacts = await this.browserManager.getSessionArtifacts();
                    console.log(`[Worker ${this.workerId}] Session artifacts collected:`, {
                        screenshots: artifacts?.screenshots?.length || 0,
                        videos: artifacts?.videos?.length || 0,
                        traces: artifacts?.traces?.length || 0,
                        har: artifacts?.har?.length || 0
                    });
                    result.artifacts = artifacts || { screenshots: [], videos: [] };

                    // Also include any screenshots from the scenario result
                    if (scenarioResult.artifacts && scenarioResult.artifacts.screenshots) {
                        result.artifacts.screenshots = [
                            ...result.artifacts.screenshots,
                            ...scenarioResult.artifacts.screenshots
                        ];
                    }
                } catch (e) {
                    console.debug(`[Worker ${this.workerId}] Error collecting artifacts: ${e}`);
                    result.artifacts = scenarioResult.artifacts || { screenshots: [], videos: [] };
                }
            } else {
                result.artifacts = scenarioResult.artifacts || { screenshots: [], videos: [] };
            }
        }

        result.duration = Date.now() - startTime;

        // Send performance metrics periodically
        if (this.performanceMetrics.size > 0 && Math.random() < 0.1) { // 10% of the time
            this.sendMessage({
                type: 'metrics',
                metrics: Object.fromEntries(this.performanceMetrics)
            });
        }

        this.sendMessage(result);
    }

    private sendMessage(message: any) {
        try {
            // Check if we can actually send messages
            if (!process.send) {
                return; // Not in a child process, can't send
            }

            if (!process.connected) {
                console.error(`[Worker ${this.workerId}] Cannot send message - process not connected`);
                return;
            }

            // Send message without callback to avoid TypeScript version conflicts
            // Different TS versions (5.3 vs 5.9+) have incompatible process.send() signatures
            // Using the simplest form that works across all versions
            const sendResult = process.send(message);

            // Handle buffer full (returns false if message couldn't be queued)
            if (sendResult === false) {
                console.debug(`[Worker ${this.workerId}] Message buffer full, message may be delayed`);
            }
        } catch (error: any) {
            // Handle synchronous errors (EPIPE, etc.)
            if (error.code !== 'EPIPE') {
                console.error(`[Worker ${this.workerId}] Error sending message:`, error.message);
            }
        }
    }

    private async cleanup() {
        try {
            // Clean up AI integration for this worker
            try {
                const { CSAIIntegrationLayer } = this.getModule('../ai/integration/CSAIIntegrationLayer');
                // Use the same worker ID format that CSBDDRunner uses (from environment)
                const workerId = process.env.WORKER_ID || 'main';
                CSAIIntegrationLayer.clearInstance(workerId);
                console.log(`[Worker ${this.workerId}] AI integration cleaned up (ID: ${workerId})`);
            } catch (error: any) {
                // AI integration not loaded, skip
            }

            // Get browser manager singleton - it's created by the BDD runner, not stored in this.browserManager
            const browserLaunchRequired = this.configManager?.getBoolean('BROWSER_LAUNCH_REQUIRED', true);

            if (browserLaunchRequired !== false) {
                try {
                    const { CSBrowserManager } = this.getModule('../browser/CSBrowserManager');
                    const browserManager = CSBrowserManager.getInstance();

                    const finalStatus = this.anyTestFailed ? 'failed' : 'passed';
                    console.log(`[Worker ${this.workerId}] Closing browser (overall: ${finalStatus})...`);
                    await browserManager.closeAll(finalStatus);
                    console.log(`[Worker ${this.workerId}] Browser closed, HAR/video artifacts handled`);
                } catch (error: any) {
                    // Browser manager not initialized (e.g., API-only tests)
                }
            }

            if (this.bddRunner && typeof this.bddRunner.cleanup === 'function') {
                await this.bddRunner.cleanup();
            }
        } catch (e) {
            console.error(`[Worker ${this.workerId}] Error during cleanup:`, e);
        }
    }
}

// Start worker if run directly
if (require.main === module) {
    new WorkerProcess();
}

export { WorkerProcess };