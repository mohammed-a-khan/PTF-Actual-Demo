#!/usr/bin/env node

// PERFORMANCE FIX: Only import minimist at top level to avoid 25-second delay
// All other imports moved to lazy loading inside functions
import minimist from 'minimist';

// ============================================================================
// EXPORTS DISABLED FOR CLI PERFORMANCE
// These exports cause all modules to load at startup, adding 20-25 seconds
// If you need to use this as a library, create a separate entry point
// ============================================================================

/* COMMENTED OUT FOR PERFORMANCE - DO NOT UNCOMMENT IN CLI MODE */
// export * from './core/CSConfigurationManager';
// export * from './core/CSBasePage';
// export * from './browser/CSBrowserManager';
// export * from './browser/CSBrowserPool';
// export * from './element/CSWebElement';
// export * from './bdd/CSBDDRunner';
// export * from './api/CSAPIClient';
// export * from './api/CSAPIRunner';
// export * from './api/CSAPIValidator';
// export * from './api/CSAPIExecutor';
// export * from './api/types/CSApiTypes';
// export * from './api/client/CSHttpClient';
// export * from './api/client/CSRequestBuilder';
// export * from './api/client/CSAuthenticationHandler';
// export * from './api/client/CSResponseParser';
// export * from './api/client/CSConnectionPool';
// export * from './api/client/CSRetryHandler';
// export * from './api/client/CSProxyManager';
// export { CSApiContext } from './api/context/CSApiContext';
// export { CSApiContextManager } from './api/context/CSApiContextManager';
// export { CSApiChainContext, CSApiChainManager, chainManager, CSChainState, CSChainWorkflow } from './api/context/CSApiChainContext';
// export { CSOAuth2Handler } from './api/auth/CSOAuth2Handler';
// export { CSAWSSignatureHandler } from './api/auth/CSAWSSignatureHandler';
// export { CSCertificateManager } from './api/auth/CSCertificateManager';
// export * from './api/templates/CSPlaceholderResolver';
// export * from './api/templates/CSRequestTemplateEngine';
// export * from './api/templates/CSTemplateCache';
// export * from './api/validators/CSStatusCodeValidator';
// export * from './api/validators/CSHeaderValidator';
// export * from './api/validators/CSBodyValidator';
// export * from './api/validators/CSSchemaValidator';
// export * from './api/validators/CSJSONPathValidator';
// export * from './api/validators/CSXMLValidator';
// export * from './database/CSDatabaseManager';
// export * from './ado/CSADOClient';
// export * from './ai/CSAIEngine';
// export * from './dashboard/CSLiveDashboard';
// AI Platform Exports
// export { CSIntelligentAI } from './ai/CSIntelligentAI';
// export { CSNaturalLanguageEngine } from './ai/nlp/CSNaturalLanguageEngine';
// export { CSFeatureExtractor } from './ai/features/CSFeatureExtractor';
// export { CSDOMIntelligence } from './ai/analysis/CSDOMIntelligence';
// export { CSSimilarityEngine } from './ai/similarity/CSSimilarityEngine';
// export { CSPatternMatcher } from './ai/patterns/CSPatternMatcher';
// export { CSIntelligentHealer } from './ai/healing/CSIntelligentHealer';
// export { CSAIHistory } from './ai/learning/CSAIHistory';
// export { CSStrategyOptimizer } from './ai/learning/CSStrategyOptimizer';
// export { CSPatternLearner } from './ai/learning/CSPatternLearner';
// export { CSPredictiveHealer } from './ai/prediction/CSPredictiveHealer';
// export * from './ai/types/AITypes';
// export * from './evidence/CSEvidenceCollector';
// export { CSPageFactory } from './core/CSPageFactory';
// export { CSReporter } from './reporter/CSReporter';
// export { CSStepRegistry, CSBDDStepDef } from './bdd/CSStepRegistry';
// export { CSDataProvider } from './data/CSDataProvider';
// export { CSPipelineOrchestrator } from './pipeline/CSPipelineOrchestrator';
// export { CSTokenManager } from './auth/CSTokenManager';
// export { CSPerformanceMonitor } from './monitoring/CSPerformanceMonitor';
// export { CSElementResolver } from './element/CSElementResolver';
/* END COMMENTED EXPORTS */

// Lightning-fast startup - minimal core loading
const startTime = Date.now();

// Lightweight log level checker for direct console.log calls
// This avoids importing CSReporter during startup for performance
const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR'] as const;
type LogLevel = typeof LOG_LEVELS[number];

function shouldLog(level: LogLevel): boolean {
    const configuredLevel = (process.env.LOG_LEVEL || 'DEBUG').toUpperCase() as LogLevel;
    const currentLevelIndex = LOG_LEVELS.indexOf(level);
    const configuredLevelIndex = LOG_LEVELS.indexOf(configuredLevel);

    // If level not found in hierarchy, default to showing it
    if (currentLevelIndex === -1 || configuredLevelIndex === -1) {
        return true;
    }

    return currentLevelIndex >= configuredLevelIndex;
}

async function main() {
    try {
        // Parse command line arguments
        const args = minimist(process.argv.slice(2));

        // Handle help and version flags without loading modules
        if (args.help || args.h) {
            console.log(`
CS Test Automation Framework

Usage: npx cs-playwright-test [options]

Single Project Mode:
  --project <name>      Project name (required)
  --features <path>     Path to feature files
  --tags <tags>         Tags to filter scenarios
  --modules <list>      Explicit module specification (api, database, ui, soap)
  --parallel            Run scenarios in parallel
  --workers <n>         Number of parallel workers
  --headless            Run browser in headless mode
  --browser <type>      Browser type (chromium, firefox, webkit)
  --lazy-steps          Enable lazy step loading (30-60x faster startup)

Multi-Project Suite Mode:
  --suite=multi-project       Run multiple projects sequentially
  --suite-config <path>       Path to test-suite.yaml config file
  --suite-mode <mode>         Filter: all, api-only, ui-only
  --suite-stop-on-failure     Stop execution on first project failure
  --environment <env>         Override environment for all projects
  --tags <tags>               Override tags for all projects

General:
  --help                Show this help message
  --version             Show version

Examples:
  # Run single project
  npx cs-playwright-test --project=web-app --features=test/features/login.feature

  # Run multi-project suite
  npx cs-playwright-test --suite=multi-project

  # Run suite with specific mode
  npx cs-playwright-test --suite=multi-project --suite-mode=api-only
`);
            process.exit(0);
        }

        if (args.version || args.v) {
            console.log('CS Test Automation Framework v3.0.0');
            process.exit(0);
        }

        // Lazy load configuration manager to avoid startup delay
        const { CSConfigurationManager } = await import('./core/CSConfigurationManager');

        // Initialize configuration (< 100ms)
        const config = CSConfigurationManager.getInstance();
        await config.initialize(args);
        
        // Check startup time
        const configTime = Date.now() - startTime;
        if (configTime > 100) {
            console.warn(`Configuration loading: ${configTime}ms (target: <100ms)`);
        }
        
        // Determine execution scope (< 20ms)
        const scopeStart = Date.now();
        const executionMode = determineExecutionMode(args, config);
        
        const scopeTime = Date.now() - scopeStart;
        if (scopeTime > 20) {
            console.warn(`Scope determination: ${scopeTime}ms (target: <20ms)`);
        }
        
        // Selective module loading (< 200ms)
        const moduleStart = Date.now();
        await loadRequiredModules(executionMode, config);
        
        const moduleTime = Date.now() - moduleStart;
        if (moduleTime > 200) {
            console.warn(`Module loading: ${moduleTime}ms (target: <200ms)`);
        }
        
        // Total startup check
        const totalStartupTime = Date.now() - startTime;

        // Lazy load reporter only when needed
        const { CSReporter } = await import('./reporter/CSReporter');

        if (totalStartupTime < 1000) {
            CSReporter.debug(`⚡ Lightning-fast startup: ${totalStartupTime}ms`);
        } else {
            CSReporter.warn(`Startup time: ${totalStartupTime}ms (target: <1000ms)`);
        }
        
        // Execute based on mode
        await execute(executionMode);
        
    } catch (error: any) {
        console.error('Framework initialization failed:', error.message);
        process.exit(1);
    }
}

function determineExecutionMode(args: any, config: any): string {
    // Check if running multi-project suite mode
    if (args.suite === 'multi-project' || args.suite === true) {
        return 'suite';
    }

    // Check if running specific tests
    if (args.feature || args.features || config.get('FEATURES')) {
        return 'bdd';
    }

    // Check if running API tests
    if (args.api || config.get('API_TESTS')) {
        return 'api';
    }

    // Check if running database tests
    if (args.db || config.get('DB_TESTS')) {
        return 'database';
    }

    // Default to BDD
    return 'bdd';
}

async function loadRequiredModules(mode: string, config: any) {
    if (shouldLog('DEBUG')) console.log(`[PERF] loadRequiredModules called for mode: ${mode}`);
    const lazyLoading = config.getBoolean('LAZY_LOADING', true);
    const parallel = config.getBoolean('PARALLEL_INITIALIZATION', true);

    // ALWAYS skip module loading if lazy loading is enabled
    if (lazyLoading) {
        if (shouldLog('DEBUG')) console.log(`[PERF] Lazy loading enabled - skipping module preload`);
        return;  // Don't preload ANY modules
    }

    if (!lazyLoading) {
        // Load all modules (slower)
        await Promise.all([
            import('./browser/CSBrowserManager'),
            import('./bdd/CSBDDRunner'),
            import('./reporter/CSReporter')
        ]);
        return;
    }
    
    // Don't preload anything - let modules load on demand
}

async function execute(mode: string) {
    const args = minimist(process.argv.slice(2));

    // Lazy load configuration manager
    const { CSConfigurationManager } = await import('./core/CSConfigurationManager');
    const config = CSConfigurationManager.getInstance();

    switch (mode) {
        case 'suite':
            // Multi-project suite execution
            if (shouldLog('INFO')) console.log('[INFO] Starting multi-project suite execution...');
            const { CSSuiteOrchestrator } = await import('./suite/CSSuiteOrchestrator');
            const orchestrator = CSSuiteOrchestrator.getInstance();

            // Build CLI options for suite
            const suiteCliOptions: any = {
                suite: args.suite,
                suiteConfig: args['suite-config'],
                suiteMode: args['suite-mode'],
                suiteStopOnFailure: args['suite-stop-on-failure'],
                tags: args.tags,
                environment: args.environment || args.env,
                headless: args.headless,
                parallel: args.parallel,
                workers: args.workers
            };

            // Run suite
            const suiteResult = await orchestrator.run({
                configPath: args['suite-config'],
                cliOptions: suiteCliOptions
            });

            // Exit with appropriate code
            if (suiteResult.status === 'failed') {
                process.exit(1);
            }
            break;

        case 'bdd':
            if (shouldLog('DEBUG')) console.log('[PERF] About to import CSBDDRunner...');
            const importStart = Date.now();
            const { CSBDDRunner } = await import('./bdd/CSBDDRunner');
            if (shouldLog('DEBUG')) console.log(`[PERF] CSBDDRunner imported in ${Date.now() - importStart}ms`);
            const runner = CSBDDRunner.getInstance();

            if (shouldLog('DEBUG')) console.log('[DEBUG] Parsed args:', JSON.stringify(args, null, 2));
            if (shouldLog('DEBUG')) console.log('[DEBUG] args.features:', args.features);
            if (shouldLog('DEBUG')) console.log('[DEBUG] args.feature:', args.feature);
            if (shouldLog('DEBUG')) console.log('[DEBUG] args.f:', args.f);

            // Pass CLI options to the runner
            const options: any = {};
            
            // Pass the project parameter - CRITICAL for loading project config
            if (args.project) {
                options.project = args.project;
            }
            
            // Handle features/feature path
            if (args.features || args.feature || args.f) {
                const featurePath = args.features || args.feature || args.f;
                if (shouldLog('DEBUG')) console.log('[DEBUG] Setting options.features to:', featurePath);
                options.features = featurePath;
                // Set both FEATURES and FEATURE_PATH for compatibility
                config.set('FEATURES', featurePath);
                config.set('FEATURE_PATH', featurePath);
            } else {
                if (shouldLog('WARN')) console.log('[WARN] No --features argument found in args!');
            }
            
            // Handle tags
            if (args.tags || args.t) {
                const tags = args.tags || args.t;
                options.tags = tags;
                config.set('TAGS', tags);
            }
            
            // Handle scenario
            if (args.scenario || args.s) {
                const scenario = args.scenario || args.s;
                options.scenario = scenario;
                config.set('SCENARIO', scenario);
            }
            
            // Handle headless mode
            if (args.headless !== undefined) {
                options.headless = args.headless;
                config.set('HEADLESS', String(args.headless));
            }
            
            // Handle browser
            if (args.browser) {
                options.browser = args.browser;
                config.set('BROWSER', args.browser);
            }

            // Handle explicit module specification
            if (args.modules || args.m) {
                const modules = args.modules || args.m;
                options.modules = modules;
                config.set('MODULES', modules);
            }

            // Handle parallel execution with workers
            if (args.parallel !== undefined || args.workers !== undefined) {
                const workerCount = args.workers ? parseInt(args.workers) : 3;

                if (args.parallel === true || args.parallel === 'true') {
                    // When parallel is true, set it to the number of workers
                    options.parallel = workerCount;
                    config.set('PARALLEL', String(workerCount));
                    config.set('MAX_PARALLEL_WORKERS', String(workerCount));
                } else if (args.parallel === false || args.parallel === 'false') {
                    // Explicitly disabled
                    options.parallel = 1;
                    config.set('PARALLEL', '1');
                } else if (typeof args.parallel === 'number' || typeof args.parallel === 'string') {
                    // Numeric value provided
                    options.parallel = typeof args.parallel === 'number' ? args.parallel : parseInt(args.parallel);
                    config.set('PARALLEL', String(options.parallel));
                } else if (args.workers && !args.parallel) {
                    // Only workers specified, treat as parallel
                    options.parallel = workerCount;
                    config.set('PARALLEL', String(workerCount));
                }
            }

            // Handle retry count
            if (args.retry !== undefined) {
                options.retry = args.retry;
                config.set('RETRY_COUNT', String(args.retry));
            }

            // Handle environment
            if (args.env || args.environment) {
                const env = args.env || args.environment;
                options.env = env;
                options.environment = env;
                config.set('ENVIRONMENT', env);
            }

            // Handle lazy step loading (PERFORMANCE: 30-60x faster startup)
            if (args['lazy-steps'] !== undefined || args.lazySteps !== undefined) {
                const lazySteps = args['lazy-steps'] ?? args.lazySteps;
                config.set('LAZY_STEP_LOADING', String(lazySteps));
            }

            if (shouldLog('DEBUG')) console.log('[DEBUG] Final options being passed to runner.run():', JSON.stringify(options, null, 2));

            await runner.run(options);
            break;
            
        case 'api':
            const { CSAPIExecutor } = await import('./api/CSAPIExecutor');
            const { CSReporter: Reporter } = await import('./reporter/CSReporter');
            const apiExecutor = new CSAPIExecutor();
            // Execute API tests based on configuration
            Reporter.info('API testing mode activated');
            break;
            
        case 'database':
            const { CSDatabaseRunner } = await import('./database/CSDatabaseRunner');
            const dbRunner = new CSDatabaseRunner();
            await dbRunner.run();
            break;
            
        default:
            throw new Error(`Unknown execution mode: ${mode}`);
    }
}

// Run if executed directly
if (require.main === module) {
    main()
        .then(() => {
            // Ensure process exits after successful completion
            process.exit(0);
        })
        .catch(error => {
            console.error('Fatal error:', error);
            process.exit(1);
        });
}

export { main };