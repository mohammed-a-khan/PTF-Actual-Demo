// Lazy load playwright to improve startup performance (saves 27s)
// import { test as base, Page, BrowserContext } from '@playwright/test';
type Page = any;
type BrowserContext = any;
import { CSBDDEngine, ParsedFeature, ParsedScenario, ParsedStep, ParsedExamples, ExternalDataSource } from './CSBDDEngine';
import { CSBDDContext } from './CSBDDContext';
import { CSDataProvider } from '../data/CSDataProvider';
import { CSFeatureContext } from './CSFeatureContext';
import { CSScenarioContext } from './CSScenarioContext';
import { executeStep, getHooks, DataTable } from './CSBDDDecorators';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';
import { CSModuleDetector, ModuleRequirements } from '../core/CSModuleDetector';
import { CSStepLoader } from '../core/CSStepLoader';
// Lazy load CSBrowserManager to improve startup performance (saves 36s)
// Will be loaded when actually needed
// import { CSBrowserManager } from '../browser/CSBrowserManager';
let CSBrowserManager: any = null;
import { CSTestResultsManager } from '../reporter/CSTestResultsManager';
// Lazy load heavy report generators to improve startup performance
// These will be loaded only when needed at the end of test execution
type ProfessionalTestSuite = any;
type TestFeature = any;
type TestScenario = any;
type TestStep = any;
import { CSStepValidator } from './CSStepValidator';
import { CSPageDiagnostics } from '../diagnostics/CSPageDiagnostics';
// Lazy load ADO integration to improve startup performance
// import { CSADOIntegration } from '../ado/CSADOIntegration';
let CSADOIntegration: any = null;
// Lazy load AI Integration to improve startup performance
// import { CSAIIntegrationLayer } from '../ai/integration/CSAIIntegrationLayer';
let CSAIIntegrationLayer: any = null;
// Lazy load locator extractor
let CSLocatorExtractor: any = null;
// Parallel execution imports are loaded dynamically when needed
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { glob } from 'glob';

export interface RunOptions {
    features?: string | string[];
    tags?: string;
    excludeTags?: string;
    scenario?: string;
    parallel?: boolean | number;  // Support both boolean and number for backward compatibility
    workers?: number;              // Number of parallel workers
    retry?: number;
    dryRun?: boolean;
    failFast?: boolean;
    stepTimeout?: number;
    screenshot?: 'always' | 'onFailure' | 'never';
    video?: 'always' | 'onFailure' | 'never';
    report?: string[];
    [key: string]: any;  // Allow additional properties
}

export class CSBDDRunner {
    private static instance: CSBDDRunner;
    private bddEngine: CSBDDEngine;
    private config: CSConfigurationManager;
    private context: CSBDDContext;
    private featureContext: CSFeatureContext;
    private scenarioContext: CSScenarioContext;
    private browserManager: any; // CSBrowserManager - lazy loaded
    private resultsManager: CSTestResultsManager;
    private failedScenarios: Array<{scenario: string, feature: string, error: string}> = [];
    private testSuite: ProfessionalTestSuite;
    private currentFeature: TestFeature | null = null;
    private currentScenario: TestScenario | null = null;
    private passedCount: number = 0;
    private failedCount: number = 0;
    private skippedCount: number = 0;
    private anyTestFailed: boolean = false;  // Track if any test failed for HAR decision
    private passedSteps: number = 0;
    private failedSteps: number = 0;
    private skippedSteps: number = 0;
    private startTime: number = Date.now();
    private testResults: any = {};
    private parallelExecutionDone: boolean = false;
    private scenarioCountForReuse: number = 0;
    private adoIntegration: any; // CSADOIntegration - lazy loaded
    private aiIntegration: any; // CSAIIntegrationLayer - lazy loaded
    private lastScenarioError: any = null; // Track last scenario error for ADO reporting

    private constructor() {
        this.bddEngine = CSBDDEngine.getInstance();
        this.config = CSConfigurationManager.getInstance();
        this.context = CSBDDContext.getInstance();
        this.featureContext = CSFeatureContext.getInstance();
        this.scenarioContext = CSScenarioContext.getInstance();
        // Lazy load browser manager - will be loaded when first test runs
        this.browserManager = null;
        this.resultsManager = CSTestResultsManager.getInstance();
        this.testSuite = this.initializeTestSuite();
        // Lazy load ADO integration - will be loaded when first test runs
        this.adoIntegration = null;
        // Lazy load AI integration - will be loaded when needed
        this.aiIntegration = null;
    }
    
    private initializeTestSuite(): ProfessionalTestSuite {
        return {
            id: `suite-${Date.now()}`,
            name: 'CS Test Automation Suite',
            project: this.config.get('PROJECT', 'CS Framework'),
            environment: {
                os: `${os.platform()} ${os.release()}`,
                browser: this.config.get('BROWSER', 'chrome'),
                browserVersion: 'latest',
                playwright: '1.40.0',
                node: process.version,
                ci: process.env.CI ? process.env.CI_NAME || 'CI' : undefined,
                buildNumber: process.env.BUILD_NUMBER,
                branch: process.env.BRANCH_NAME,
                commit: process.env.COMMIT_SHA
            },
            startTime: new Date(),
            endTime: new Date(),
            duration: 0,
            features: [],
            categories: [],
            timeline: [],
            history: []
        };
    }
    
    public static getInstance(): CSBDDRunner {
        if (!CSBDDRunner.instance) {
            CSBDDRunner.instance = new CSBDDRunner();
        }
        return CSBDDRunner.instance;
    }

    /**
     * Ensure browser manager is loaded (lazy loading)
     */
    private async ensureBrowserManager(): Promise<any> {
        if (!this.browserManager) {
            // Lazy load CSBrowserManager only when needed
            if (!CSBrowserManager) {
                CSBrowserManager = require('../browser/CSBrowserManager').CSBrowserManager;
            }
            this.browserManager = CSBrowserManager.getInstance();
        }
        return this.browserManager;
    }

    /**
     * Ensure ADO integration is loaded (lazy loading)
     */
    private ensureADOIntegration(): any {
        if (!this.adoIntegration) {
            // Lazy load CSADOIntegration only when needed
            if (!CSADOIntegration) {
                CSADOIntegration = require('../ado/CSADOIntegration').CSADOIntegration;
            }
            this.adoIntegration = CSADOIntegration.getInstance();
        }
        return this.adoIntegration;
    }

    /**
     * Ensure AI integration is loaded (lazy loading)
     */
    private ensureAIIntegration(): any {
        if (!this.aiIntegration) {
            // Lazy load CSAIIntegrationLayer only when needed
            if (!CSAIIntegrationLayer) {
                CSAIIntegrationLayer = require('../ai/integration/CSAIIntegrationLayer').CSAIIntegrationLayer;
            }
            // Get worker ID from environment or use 'main' for sequential execution
            const workerId = process.env.WORKER_ID || 'main';
            this.aiIntegration = CSAIIntegrationLayer.getInstance(workerId);
        }
        return this.aiIntegration;
    }

    /**
     * Get test results for parallel worker reporting
     */
    public getTestResults(): any[] {
        return this.testSuite?.features || [];
    }

    /**
     * Get test statistics for parallel worker reporting
     */
    public getStats(): { passed: number; failed: number; skipped: number } {
        let passed = 0;
        let failed = 0;
        let skipped = 0;

        if (this.testSuite && this.testSuite.features) {
            for (const feature of this.testSuite.features) {
                for (const scenario of feature.scenarios) {
                    if (scenario.status === 'passed') passed++;
                    else if (scenario.status === 'failed') failed++;
                    else if (scenario.status === 'skipped') skipped++;
                }
            }
        }

        return { passed, failed, skipped };
    }

    public async run(options: RunOptions = {}): Promise<void> {
        const startTime = Date.now();
        this.testSuite.startTime = new Date();

        try {
            CSReporter.debug(`[CSBDDRunner.run] Received options: ${JSON.stringify(options)}`);
            // Initialize configuration
            await this.config.initialize(options);

            // Initialize retry count from config if not provided in options
            if (options.retry === undefined) {
                const retryCount = this.config.getNumber('RETRY_COUNT', 0);
                if (retryCount > 0) {
                    options.retry = retryCount;
                    CSReporter.debug(`Retry count initialized from config: ${retryCount}`);
                }
            }

            // Initialize test results directory
            const project = this.config.get('PROJECT', 'CS-Framework');
            this.resultsManager.initializeTestRun(project);

            // Parse features
            const features = await this.loadFeatures(options);
            
            if (features.length === 0) {
                CSReporter.warn('No features found to execute');
                return;
            }
            
            CSReporter.info(`Found ${features.length} features to execute`);

            // Only skip step loading if explicitly running in parallel mode
            // For parallel execution, workers will load their own steps
            const isParallelMode = options.parallel === true ||
                                  (typeof options.parallel === 'number' && options.parallel > 1);

            if (!isParallelMode) {
                // Set the step definition paths from configuration for the project
                const project = this.config.get('PROJECT', 'common');
                const stepPaths = this.config.get('STEP_DEFINITIONS_PATH', 'test/common/steps;test/{project}/steps;test/{project}/step-definitions;src/steps');

                // Parse paths and replace {project} placeholder
                const paths = stepPaths.split(';').map(p => p.trim().replace('{project}', project));

                // PERFORMANCE: Scan page directories for lazy loading BEFORE loading steps
                // This allows @Page decorator to work without importing page classes directly
                const { CSPageRegistry } = await import('../core/CSPageRegistry');
                const pageRegistry = CSPageRegistry.getInstance();
                const pagePaths = this.config.get('PAGE_DEFINITIONS_PATH', `test/${project}/pages;test/common/pages`);
                const pageDirectories = pagePaths.split(';').map(p => p.trim().replace('{project}', project));
                pageRegistry.setPageDirectories(pageDirectories);
                await pageRegistry.scanPages();

                // Set the paths in BDD engine for selective loading
                this.bddEngine.setStepDefinitionPaths(paths);

                // Load required step definitions using selective loading
                await this.bddEngine.loadRequiredStepDefinitions(features);

                // Load framework steps with file-level filtering
                let aggregatedRequirements: ModuleRequirements;

                // Check if user explicitly specified modules via --modules flag
                const explicitModules = this.config.get('MODULES');

                if (explicitModules) {
                    // User explicitly specified modules - override auto-detection
                    const moduleList = explicitModules.split(',').map(m => m.trim().toLowerCase());
                    aggregatedRequirements = {
                        api: moduleList.includes('api'),
                        database: moduleList.includes('database') || moduleList.includes('db'),
                        soap: moduleList.includes('soap'),
                        browser: moduleList.includes('ui') || moduleList.includes('browser')
                    };
                    CSReporter.debug(`Explicit modules specified via --modules: ${explicitModules}`);
                } else {
                    // Auto-detect and aggregate module requirements from all features
                    const moduleDetector = CSModuleDetector.getInstance();
                    aggregatedRequirements = {
                        browser: false,
                        api: false,
                        database: false,
                        soap: false
                    };

                    for (const feature of features) {
                        for (const scenario of feature.scenarios) {
                            const req = moduleDetector.detectRequirements(scenario, feature);
                            aggregatedRequirements.browser = aggregatedRequirements.browser || req.browser;
                            aggregatedRequirements.api = aggregatedRequirements.api || req.api;
                            aggregatedRequirements.database = aggregatedRequirements.database || req.database;
                            aggregatedRequirements.soap = aggregatedRequirements.soap || req.soap;
                        }
                    }
                }

                const stepLoader = CSStepLoader.getInstance();
                await stepLoader.loadRequiredSteps(aggregatedRequirements, features);
            } else {
                CSReporter.debug('Skipping step loading in main process for parallel execution');
            }

            // Check if validation is enabled
            const validationLevel = this.config.get('VALIDATION_LEVEL', 'strict').toLowerCase();

            if (validationLevel !== 'none') {
                const validateSteps = this.config.getBoolean('VALIDATE_DUPLICATE_STEPS', true);
                const validateMethods = this.config.getBoolean('VALIDATE_DUPLICATE_METHODS', true);

                if (validateSteps || validateMethods) {
                    // Validate step definitions for duplicates
                    const stepValidator = CSStepValidator.getInstance();

                    // Get all loaded step files for validation
                    const stepFiles = this.getAllLoadedStepFiles();

                    CSReporter.info('🔍 Validating step definitions and methods for duplicates...');
                    const validationResult = await stepValidator.validateStepFiles(stepFiles);

                    if (!validationResult.isValid) {
                        // Report all errors
                        CSReporter.error('═══════════════════════════════════════════════════════════════');
                        CSReporter.error('                    VALIDATION FAILED                          ');
                        CSReporter.error('═══════════════════════════════════════════════════════════════');

                        if (validationResult.duplicateSteps.size > 0 && validateSteps) {
                            CSReporter.error(`\n❌ Found ${validationResult.duplicateSteps.size} duplicate step definition(s):`);
                            validationResult.duplicateSteps.forEach((locations: any, pattern: any) => {
                                CSReporter.error(`\n  Step: "${pattern}"`);
                                locations.forEach((loc: any) => {
                                    CSReporter.error(`    - ${loc.file}:${loc.line}`);
                                });
                            });
                        }

                        if (validationResult.duplicateMethods.size > 0 && validateMethods) {
                            CSReporter.error(`\n❌ Found ${validationResult.duplicateMethods.size} duplicate method(s) across files:`);
                            validationResult.duplicateMethods.forEach((locations: any, methodName: any) => {
                                CSReporter.error(`\n  Method: "${methodName}"`);
                                locations.forEach((loc: any) => {
                                    CSReporter.error(`    - ${loc.file}:${loc.line}`);
                                });
                            });
                        }

                        CSReporter.error('\n═══════════════════════════════════════════════════════════════');

                        if (validationLevel === 'strict') {
                            CSReporter.error('❌ Test execution aborted due to validation errors');
                            CSReporter.error('Please fix the duplicate definitions before running tests');
                            CSReporter.error('Set VALIDATION_LEVEL=warning to continue with warnings');
                            CSReporter.error('═══════════════════════════════════════════════════════════════');

                            // Throw error to stop execution
                            throw new Error('Validation failed: Duplicate step definitions or method names detected');
                        } else {
                            CSReporter.warn('⚠️  Continuing with validation warnings...');
                            CSReporter.warn('Set VALIDATION_LEVEL=strict to enforce validation');
                            CSReporter.warn('═══════════════════════════════════════════════════════════════');
                        }
                    } else {
                        CSReporter.pass('✅ All validations passed - no duplicates found');
                    }
                }
            } else {
                CSReporter.debug('Validation skipped (VALIDATION_LEVEL=none)');
            }

            // Execute features
            if (options.dryRun) {
                await this.dryRun(features);
            } else {
                await this.executeFeatures(features, options);
            }

            // Generate reports only if parallel execution didn't already generate them
            if (!this.parallelExecutionDone) {
                await this.generateReports(options.report || ['html', 'json']);
            }

            const duration = Date.now() - startTime;
            this.testSuite.endTime = new Date();
            this.testSuite.duration = duration;

            // Skip statistics calculation and professional report if parallel execution already generated reports
            if (!this.parallelExecutionDone) {
                // Calculate final statistics
                let totalScenarios = 0;
                let passedScenarios = 0;
                let failedScenarios = 0;
                let skippedScenarios = 0;

                this.testSuite.features.forEach((feature: any) => {
                    feature.scenarios.forEach((scenario: any) => {
                        totalScenarios++;
                        if (scenario.status === 'passed') passedScenarios++;
                        else if (scenario.status === 'failed') failedScenarios++;
                        else skippedScenarios++;
                    });
                });

                // Update testSuite with calculated statistics
                (this.testSuite as any).totalScenarios = totalScenarios;
                (this.testSuite as any).passedScenarios = passedScenarios;
                (this.testSuite as any).failedScenarios = failedScenarios;
                (this.testSuite as any).skippedScenarios = skippedScenarios;

                CSReporter.info(`Test execution completed: ${totalScenarios} scenarios (${passedScenarios} passed, ${failedScenarios} failed, ${skippedScenarios} skipped)`);

                // Generate professional report will be moved after browser close to ensure HAR files are saved
            }
            
            // Finalize test run (ZIP if configured) - only for sequential execution
            // For parallel execution, this is done in CSReportAggregator
            if (!this.parallelExecutionDone) {
                await this.resultsManager.finalizeTestRun();
            }

            CSReporter.pass(`Test execution completed in ${duration}ms`);

            // Close browsers BEFORE generating report so HAR/video files are saved
            // This is important for browser reuse mode where artifacts are only saved on context close
            try {
                // Pass the overall test status for proper HAR file handling
                const overallStatus = this.hasFailures() ? 'failed' : 'passed';
                if (this.browserManager) {
                    await this.browserManager.closeAll(overallStatus);
                }
                CSReporter.debug(`All browsers closed - artifacts should be saved (overall status: ${overallStatus})`);
            } catch (error) {
                CSReporter.debug('Error closing browsers: ' + error);
            }

            // Generate professional report AFTER closing browsers to ensure all artifacts are saved
            if (!this.parallelExecutionDone) {
                await this.generateProfessionalReport();
            }

            // Complete ADO test run AFTER professional report to ensure all artifacts are included in zip
            const adoIntegration = this.ensureADOIntegration();
            await adoIntegration.afterAllTests();

        } catch (error: any) {
            CSReporter.error(`Test execution failed: ${error.message}`);
            throw error;
        } finally {
            // Browser already closed above, no need to close again
        }
    }
    
    private async loadFeatures(options: RunOptions): Promise<ParsedFeature[]> {
        CSReporter.debug(`[loadFeatures] options.features = ${JSON.stringify(options.features)}`);
        const featurePaths = this.resolveFeaturePaths(options.features);
        CSReporter.debug(`[loadFeatures] Resolved ${featurePaths.length} feature file(s): ${JSON.stringify(featurePaths.slice(0, 3))}...`);
        const filters = {
            tags: options.tags,
            excludeTags: options.excludeTags,
            scenario: options.scenario
        };
        
        const allFeatures: ParsedFeature[] = [];
        
        // All paths are now resolved to actual feature files
        for (const featurePath of featurePaths) {
            try {
                const feature = this.bddEngine.parseFeature(featurePath);
                // Apply filters to single feature
                if (this.matchesFilters(feature, filters)) {
                    allFeatures.push(feature);
                }
            } catch (error: any) {
                CSReporter.error(`Failed to parse feature file ${featurePath}: ${error.message}`);
            }
        }
        
        return allFeatures;
    }
    
    private resolveFeaturePaths(features?: string | string[]): string[] {
        CSReporter.debug(`[resolveFeaturePaths] Input features param: ${JSON.stringify(features)}`);
        CSReporter.debug(`[resolveFeaturePaths] Type: ${typeof features}, Is undefined: ${features === undefined}, Is null: ${features === null}, Is empty string: ${features === ''}, Is falsy: ${!features}`);
        let pathsToProcess: string[] = [];

        if (!features) {
            CSReporter.warn(`[resolveFeaturePaths] No features parameter provided (value: ${JSON.stringify(features)}), using fallback logic`);
            // PRIORITY 1: Check for PROJECT first (highest priority)
            const project = this.config.get('PROJECT');
            if (project) {
                const projectFeaturesPath = path.join(process.cwd(), 'test', project, 'features');
                if (fs.existsSync(projectFeaturesPath)) {
                    CSReporter.debug(`Using project-specific features directory: ${projectFeaturesPath}`);
                    pathsToProcess = [projectFeaturesPath];
                }
            }

            // PRIORITY 2: Check for FEATURE_PATH only if PROJECT didn't yield results
            if (pathsToProcess.length === 0) {
                const featurePath = this.config.get('FEATURE_PATH');
                if (featurePath) {
                    // Split by ';' to support multiple paths
                    pathsToProcess = featurePath.split(';').map(p => p.trim()).filter(p => p.length > 0);
                }
            }

            // PRIORITY 3: Default to test/features directory if nothing found
            if (pathsToProcess.length === 0) {
                const defaultPath = path.join(process.cwd(), 'test/features');
                if (!fs.existsSync(defaultPath)) {
                    CSReporter.error(`No features directory found at: ${defaultPath}`);
                    throw new Error(`Features directory not found. Please specify --features=<path> or create ${defaultPath}`);
                }
                pathsToProcess = [defaultPath];
            }
        } else {
            CSReporter.debug(`[resolveFeaturePaths] Features parameter provided: ${JSON.stringify(features)}`);
            // Handle passed features (can be string with ';' or array)
            if (Array.isArray(features)) {
                pathsToProcess = features;
            } else {
                // Split by ';' or ',' to support multiple paths in a single string
                // Support both semicolon and comma as delimiters
                const delimiter = features.includes(';') ? ';' : ',';
                pathsToProcess = features.split(delimiter).map(p => p.trim()).filter(p => p.length > 0);
            }
            CSReporter.debug(`[resolveFeaturePaths] Paths to process after parsing: ${JSON.stringify(pathsToProcess)}`);
        }

        // Resolve all paths and expand glob patterns
        const resolvedFeaturePaths: string[] = [];

        for (const pathStr of pathsToProcess) {
            // Check if this is a glob pattern (contains *, ?, or [])
            const isGlobPattern = /[*?[\]]/.test(pathStr);

            if (isGlobPattern) {
                // Expand glob pattern
                CSReporter.debug(`Expanding glob pattern: ${pathStr}`);
                const expandedPaths = glob.sync(pathStr, {
                    cwd: process.cwd(),
                    absolute: true,
                    nodir: false // Include directories
                });

                if (expandedPaths.length === 0) {
                    CSReporter.warn(`Glob pattern matched no files: ${pathStr}`);
                    continue;
                }

                // Process each expanded path
                for (const expandedPath of expandedPaths) {
                    if (fs.existsSync(expandedPath)) {
                        const stat = fs.statSync(expandedPath);
                        if (stat.isDirectory()) {
                            const featureFiles = this.findFeatureFiles(expandedPath);
                            resolvedFeaturePaths.push(...featureFiles);
                        } else if (stat.isFile() && expandedPath.endsWith('.feature')) {
                            resolvedFeaturePaths.push(expandedPath);
                        }
                    }
                }
            } else {
                // Regular path (not a glob pattern)
                const cwd = process.cwd();
                const fullPath = path.isAbsolute(pathStr) ? pathStr : path.join(cwd, pathStr);
                CSReporter.debug(`[resolveFeaturePaths] Processing path: ${pathStr}`);
                CSReporter.debug(`[resolveFeaturePaths] CWD: ${cwd}`);
                CSReporter.debug(`[resolveFeaturePaths] Full path: ${fullPath}`);
                CSReporter.debug(`[resolveFeaturePaths] Path exists: ${fs.existsSync(fullPath)}`);

                if (!fs.existsSync(fullPath)) {
                    CSReporter.error(`Path does not exist: ${fullPath}`);
                    CSReporter.error(`Expected path based on CWD ${cwd} and relative path ${pathStr}`);
                    continue;
                }

                const stat = fs.statSync(fullPath);

                if (stat.isDirectory()) {
                    CSReporter.debug(`[resolveFeaturePaths] Path is directory, finding all .feature files: ${fullPath}`);
                    // Recursively find all .feature files in the directory
                    const featureFiles = this.findFeatureFiles(fullPath);
                    CSReporter.debug(`[resolveFeaturePaths] Found ${featureFiles.length} .feature files in directory`);
                    resolvedFeaturePaths.push(...featureFiles);
                } else if (stat.isFile() && fullPath.endsWith('.feature')) {
                    CSReporter.debug(`[resolveFeaturePaths] Path is a .feature file, adding: ${fullPath}`);
                    // Add individual feature file
                    resolvedFeaturePaths.push(fullPath);
                } else {
                    CSReporter.warn(`Path is not a feature file or directory: ${fullPath}`);
                }
            }
        }

        CSReporter.debug(`[resolveFeaturePaths] Total resolved paths: ${resolvedFeaturePaths.length}`);

        if (resolvedFeaturePaths.length === 0) {
            CSReporter.error(`[resolveFeaturePaths] No feature files found!`);
            CSReporter.error(`[resolveFeaturePaths] Paths that were attempted: ${JSON.stringify(pathsToProcess)}`);
            CSReporter.error(`[resolveFeaturePaths] Current working directory: ${process.cwd()}`);
            throw new Error('No feature files found in the specified paths');
        }

        const uniquePaths = [...new Set(resolvedFeaturePaths)];
        CSReporter.debug(`[resolveFeaturePaths] Returning ${uniquePaths.length} unique feature path(s)`);
        return uniquePaths;
    }
    
    private findFeatureFiles(directory: string): string[] {
        const featureFiles: string[] = [];
        
        const processDirectory = (dir: string) => {
            const items = fs.readdirSync(dir);
            
            for (const item of items) {
                const fullPath = path.join(dir, item);
                const stat = fs.statSync(fullPath);
                
                if (stat.isDirectory()) {
                    // Recursively process subdirectories
                    processDirectory(fullPath);
                } else if (stat.isFile() && item.endsWith('.feature')) {
                    featureFiles.push(fullPath);
                }
            }
        };
        
        processDirectory(directory);
        return featureFiles;
    }
    
    private matchesFilters(feature: ParsedFeature, filters: any): boolean {
        // Filter scenarios within feature
        if (filters.tags || filters.excludeTags || filters.scenario) {
            feature.scenarios = feature.scenarios.filter(scenario => {
                // Tag filtering
                if (filters.tags) {
                    const requiredTags = filters.tags.split(',').map((t: string) => t.trim());
                    const scenarioTags = [...feature.tags, ...scenario.tags];
                    if (!requiredTags.some((tag: string) => scenarioTags.includes(tag))) {
                        return false;
                    }
                }
                
                // Exclude tags
                if (filters.excludeTags) {
                    const excludedTags = filters.excludeTags.split(',').map((t: string) => t.trim());
                    const scenarioTags = [...feature.tags, ...scenario.tags];
                    if (excludedTags.some((tag: string) => scenarioTags.includes(tag))) {
                        return false;
                    }
                }
                
                // Scenario name filter
                if (filters.scenario && !scenario.name.includes(filters.scenario)) {
                    return false;
                }
                
                return true;
            });
        }
        
        return feature.scenarios.length > 0;
    }
    
    private async dryRun(features: ParsedFeature[]): Promise<void> {
        CSReporter.info('=== DRY RUN MODE ===');
        
        for (const feature of features) {
            CSReporter.info(`Feature: ${feature.name}`);
            
            for (const scenario of feature.scenarios) {
                CSReporter.info(`  Scenario: ${scenario.name}`);
                
                // Include background steps if present
                if (feature.background) {
                    for (const step of feature.background.steps) {
                        CSReporter.info(`    ${step.keyword} ${step.text}`);
                    }
                }
                
                // Scenario steps
                for (const step of scenario.steps) {
                    CSReporter.info(`    ${step.keyword} ${step.text}`);
                }
                
                // Handle scenario outline
                if (scenario.examples) {
                    CSReporter.info(`    Examples:`);
                    CSReporter.info(`      | ${scenario.examples.headers.join(' | ')} |`);
                    for (const row of scenario.examples.rows) {
                        CSReporter.info(`      | ${row.join(' | ')} |`);
                    }
                }
            }
        }
    }
    
    private async executeFeatures(features: ParsedFeature[], options: RunOptions): Promise<void> {
        // Initialize ADO integration if enabled (lazy load)
        const adoIntegration = this.ensureADOIntegration();
        await adoIntegration.initialize(options.parallel ? true : false);

        // Collect all scenarios for ADO test point mapping
        const allScenarios: Array<{scenario: ParsedScenario, feature: ParsedFeature}> = [];
        for (const feature of features) {
            // Get all scenarios from feature (apply tag filters)
            for (const scenario of feature.scenarios || []) {
                // Apply tag filters
                if (this.shouldExecuteScenario(scenario, feature, options)) {
                    allScenarios.push({scenario, feature});
                }
            }
        }

        // Collect test points from all scenarios before creating test run
        await adoIntegration.collectScenarios(allScenarios);

        // Start ADO test run with collected test points
        // Don't pass a name - let ADOPublisher generate one based on feature name
        await adoIntegration.beforeAllTests();

        // Handle different types of parallel values (boolean true, number, etc.)
        let parallel = 1;
        if (typeof options.parallel === 'boolean' && options.parallel === true) {
            parallel = this.config.getNumber('MAX_PARALLEL_WORKERS', 4);
        } else if (typeof options.parallel === 'number') {
            parallel = options.parallel;
        } else {
            parallel = this.config.getNumber('PARALLEL', 1);
        }

        if (parallel > 1) {
            // Use the new parallel executor with worker threads
            const useWorkerThreads = this.config.getBoolean('USE_WORKER_THREADS', true);

            if (useWorkerThreads) {
                await this.executeWithWorkerThreads(features, options, parallel);
            } else {
                // Fallback to simple parallel execution (for compatibility)
                await this.executeParallel(features, options, parallel);
            }
        } else {
            await this.executeSequential(features, options);
        }
    }

    private shouldExecuteScenario(scenario: ParsedScenario, feature: ParsedFeature, options: RunOptions): boolean {
        // Check tag filters
        const allTags = [...(feature.tags || []), ...(scenario.tags || [])];

        // Include tag filter
        if (options.tags) {
            const includeTags = options.tags.split(',').map(t => t.trim());
            const hasIncludeTag = includeTags.some(tag =>
                allTags.includes(tag) || allTags.includes(`@${tag}`)
            );
            if (!hasIncludeTag) return false;
        }

        // Exclude tag filter
        if (options.excludeTags) {
            const excludeTags = options.excludeTags.split(',').map(t => t.trim());
            const hasExcludeTag = excludeTags.some(tag =>
                allTags.includes(tag) || allTags.includes(`@${tag}`)
            );
            if (hasExcludeTag) return false;
        }

        // Scenario name filter
        if (options.scenario) {
            const scenarioFilter = options.scenario.toLowerCase();
            if (!scenario.name.toLowerCase().includes(scenarioFilter)) {
                return false;
            }
        }

        return true;
    }

    private async executeSequential(features: ParsedFeature[], options: RunOptions): Promise<void> {
        for (const feature of features) {
            await this.executeFeature(feature, options);
        }
    }

    private async executeParallel(features: ParsedFeature[], options: RunOptions, parallel: number): Promise<void> {
        // Simple parallel execution (existing implementation)
        const chunks = this.chunkArray(features, parallel);
        const promises = chunks.map(chunk => this.executeSequential(chunk, options));
        await Promise.all(promises);
    }

    private async executeWithWorkerThreads(features: ParsedFeature[], options: RunOptions, workers: number): Promise<void> {
        CSReporter.info(`Starting parallel execution with ${workers} workers`);

        // Start capturing terminal output
        const { CSTerminalLogCapture } = require('../parallel/CSTerminalLogCapture');
        const terminalCapture = CSTerminalLogCapture.getInstance();
        terminalCapture.startCapture();

        try {
            // Use the new parallel orchestrator
            const { ParallelOrchestrator } = require('../parallel/parallel-orchestrator');
            const { CSReportAggregator } = require('../reporter/CSReportAggregator');
            const orchestrator = new ParallelOrchestrator(workers);

            // Execute features in parallel
            const results = await orchestrator.execute(features);

            // Process results and aggregate test data
            let passed = 0;
            let failed = 0;
            let skipped = 0;
            const allScenarios: any[] = [];
            const allArtifacts: any = {
                screenshots: [],
                videos: [],
                traces: [],
                logs: []
            };

            // Group results by scenario name to handle retries
            // Key: scenarioName+featureName, Value: array of attempts
            const scenarioAttempts = new Map<string, any[]>();

            for (const [workId, result] of results.entries()) {
                // Create scenario result object
                const scenarioResult = {
                    name: result.scenarioName || workId,
                    feature: result.featureName || 'Unknown',
                    tags: result.tags || [],  // Add tags from worker results
                    status: result.status,
                    duration: result.duration || 0,
                    steps: result.steps || [],
                    error: result.error,
                    artifacts: result.artifacts,
                    workerId: result.workerId || 1,  // Add worker ID for timeline
                    startTime: result.startTime || new Date(),
                    endTime: result.endTime || new Date(),
                    testData: result.testData  // Add test data for data-driven scenarios
                };

                // Group by unique key (feature + scenario name)
                const scenarioKey = `${scenarioResult.feature}::${scenarioResult.name}`;
                if (!scenarioAttempts.has(scenarioKey)) {
                    scenarioAttempts.set(scenarioKey, []);
                }
                scenarioAttempts.get(scenarioKey)!.push(scenarioResult);

                // Aggregate artifacts and copy them to main test results folder
                if (result.artifacts) {
                    // Copy artifacts from worker to main test results directory
                    const { copyArtifactsFromWorker } = require('../parallel/CSParallelMediaHandler');
                    const copiedArtifacts = await copyArtifactsFromWorker(result.artifacts, result.workerId || 1);

                    if (copiedArtifacts.screenshots) allArtifacts.screenshots.push(...copiedArtifacts.screenshots);
                    if (copiedArtifacts.videos) allArtifacts.videos.push(...copiedArtifacts.videos);
                    if (copiedArtifacts.traces) allArtifacts.traces.push(...copiedArtifacts.traces);
                    if (copiedArtifacts.logs) allArtifacts.logs.push(...copiedArtifacts.logs);
                }
            }

            // De-duplicate scenarios: keep only the last attempt (final result)
            for (const [scenarioKey, attempts] of scenarioAttempts.entries()) {
                // Sort attempts by endTime to get the most recent
                attempts.sort((a, b) => {
                    const aTime = a.endTime instanceof Date ? a.endTime.getTime() : new Date(a.endTime).getTime();
                    const bTime = b.endTime instanceof Date ? b.endTime.getTime() : new Date(b.endTime).getTime();
                    return bTime - aTime;  // Most recent first
                });

                // Take the most recent attempt (final result)
                const finalResult = attempts[0];
                allScenarios.push(finalResult);

                // Count status for unique scenarios (not retries)
                if (finalResult.status === 'passed') {
                    passed++;
                    this.passedCount++;
                } else if (finalResult.status === 'failed') {
                    failed++;
                    this.failedCount++;
                    this.anyTestFailed = true;

                    // Add to failed scenarios
                    this.failedScenarios.push({
                        scenario: finalResult.name,
                        feature: finalResult.feature,
                        error: finalResult.error || 'Test failed'
                    });
                } else {
                    skipped++;
                    this.skippedCount++;
                }

                // Increment step counts from final result only
                if (finalResult.steps) {
                    finalResult.steps.forEach((step: any) => {
                        if (step.status === 'passed') this.passedSteps++;
                        else if (step.status === 'failed') this.failedSteps++;
                        else if (step.status === 'skipped') this.skippedSteps++;
                    });
                }
            }

            // Store results for reporting
            this.testResults = {
                features: features.length,
                scenarios: allScenarios,
                totalScenarios: allScenarios.length,
                passed,
                failed,
                skipped,
                artifacts: allArtifacts,
                duration: Date.now() - this.startTime,
                parallel: true,
                workers
            };

            // Update configuration to reflect parallel execution was used
            this.config.set('PARALLEL', 'true');
            this.config.set('PARALLEL_WORKERS', String(workers));

            // Stop capturing and save terminal logs
            terminalCapture.stopCapture();
            const terminalLogPath = terminalCapture.saveLogs();
            allArtifacts.logs = allArtifacts.logs || [];
            allArtifacts.logs.push(terminalLogPath);
            CSReporter.info(`Terminal output saved to: ${terminalLogPath}`);

            // Generate reports
            const aggregator = CSReportAggregator.getInstance();
            await aggregator.aggregateParallelResults(allScenarios, allArtifacts);

            // Mark parallel execution as done to prevent regular report generation from overwriting
            this.parallelExecutionDone = true;

            // Complete ADO test run AFTER all reports are generated to ensure zip includes everything
            const adoIntegration = this.ensureADOIntegration();
            await adoIntegration.afterAllTests();

            CSReporter.info(`Parallel execution completed: ${passed} passed, ${failed} failed, ${skipped} skipped`);

        } catch (error: any) {
            CSReporter.error(`Parallel execution failed: ${error.message}`);
            // Stop capturing terminal output even on error
            terminalCapture.stopCapture();
            terminalCapture.saveLogs();
            // Fall back to sequential execution
            CSReporter.info('Falling back to sequential execution...');
            await this.executeSequential(features, options);
        }
    }

    private async processParallelResults(result: any, features: ParsedFeature[]): Promise<void> {
        // Aggregate results into testSuite for reporting
        const featureResults = new Map<string, TestFeature>();

        // Group results by feature
        result.results.forEach((workerResult: any) => {
            // Skip if taskId is missing
            if (!workerResult?.taskId) {
                CSReporter.warn('Worker result missing taskId, skipping');
                return;
            }

            // Extract feature name from taskId or use workerResult data
            const taskParts = workerResult.taskId.split('-');
            const featureIndex = parseInt(taskParts[1]) || 0;
            const feature = features[Math.min(featureIndex, features.length - 1)];

            if (!feature) return;

            if (!featureResults.has(feature.name)) {
                featureResults.set(feature.name, {
                    name: feature.name,
                    description: feature.description || '',
                    tags: feature.tags,
                    scenarios: [],
                    startTime: new Date(workerResult.startTime),
                    endTime: new Date(workerResult.endTime),
                    duration: workerResult.duration
                });
            }

            const testFeature = featureResults.get(feature.name)!;

            // Add scenario results
            const scenario: TestScenario = {
                id: `scenario-${workerResult.taskId}`,
                name: `Scenario from ${workerResult.taskId}`,
                description: '',
                feature: feature.name,
                featureFile: (feature as any).uri || feature.name,
                tags: [],
                status: workerResult.status === 'passed' ? 'passed' : 'failed',
                severity: 'major',
                priority: 'medium',
                startTime: new Date(workerResult.startTime),
                endTime: new Date(workerResult.endTime),
                duration: workerResult.duration,
                steps: workerResult.steps?.map((step: any, index: number) => ({
                    id: `step-${index}`,
                    name: `${step.keyword} ${step.text}`,
                    keyword: step.keyword,
                    status: step.status,
                    duration: step.duration || 0,
                    startTime: new Date(workerResult.startTime),
                    endTime: new Date(workerResult.endTime),
                    order: index,
                    error: step.error ? { message: step.error, stack: undefined } : undefined,
                    screenshot: (step as any).screenshot,
                    logs: [],
                    attachments: [],
                    actions: []
                } as TestStep)) || [],
                beforeHooks: [],
                afterHooks: [],
                retries: 0,
                maxRetries: 0,
                flaky: false,
                owner: undefined,
                automationPercent: 100,
                attachments: [],
                environment: {
                    browser: this.config.get('BROWSER', 'chromium'),
                    browserVersion: 'latest',
                    os: process.platform,
                    viewport: '1920x1080',
                    device: undefined
                },
                performance: {
                    averageResponseTime: 0,
                    totalMemoryUsage: 0,
                    networkRequests: 0,
                    domComplexity: 0,
                    pageLoadTime: 0
                },
                categories: [],
                labels: [],
                links: []
            };

            // Store screenshots and videos in the feature or test suite level
            if (workerResult.screenshots?.length) {
                (scenario as any).screenshots = workerResult.screenshots;
            }
            if (workerResult.videos?.length) {
                (scenario as any).videos = workerResult.videos;
            }

            // Add test data for data-driven scenarios
            if (workerResult.testData) {
                (scenario as any).testData = workerResult.testData;
            }

            testFeature.scenarios.push(scenario);
        });

        // Add aggregated features to testSuite
        featureResults.forEach(feature => {
            this.testSuite.features.push(feature);
        });
    }

    private chunkArray<T>(array: T[], size: number): T[][] {
        const chunks: T[][] = [];
        for (let i = 0; i < array.length; i += size) {
            chunks.push(array.slice(i, i + size));
        }
        return chunks;
    }
    
    private async executeFeature(feature: ParsedFeature, options: RunOptions): Promise<void> {
        CSReporter.startFeature(feature.name);
        this.featureContext.setCurrentFeature(feature.name);
        this.featureContext.setFeatureTags(feature.tags);
        this.context.setCurrentFeature(feature.name);
        
        // Create and track feature in testSuite  
        this.currentFeature = {
            name: feature.name,
            description: feature.description || '',
            tags: feature.tags,
            scenarios: [],
            startTime: new Date(),
            endTime: new Date(),
            duration: 0,
            // background will be handled separately
        };
        this.testSuite.features.push(this.currentFeature);
        
        try {
            // Execute before hooks
            await this.executeHooks('before', feature.tags);
            
            // Execute scenarios
            for (const scenario of feature.scenarios) {
                if (options.failFast && this.hasFailures()) {
                    CSReporter.warn('Stopping execution due to failFast option');
                    break;
                }
                
                await this.executeScenario(scenario, feature, options);
            }
            
            // Execute after hooks
            await this.executeHooks('after', feature.tags);
            
        } finally {
            // Update feature status based on scenarios
            if (this.currentFeature) {
                const featureEndTime = new Date();
                this.currentFeature.endTime = featureEndTime;
                this.currentFeature.duration = featureEndTime.getTime() - this.currentFeature.startTime.getTime();

                // Calculate feature status (cast to any to avoid TypeScript issues)
                const hasFailedScenarios = this.currentFeature.scenarios.some((s: any) => s.status === 'failed');
                (this.currentFeature as any).status = hasFailedScenarios ? 'failed' : 'passed';

                // Debug: Log final scenario count for this feature (commented out - uncomment for debugging)
                // CSReporter.info(`[SCENARIO-COUNT] Feature "${feature.name}" completed with ${this.currentFeature.scenarios.length} scenarios in report`);
                // const passed = this.currentFeature.scenarios.filter((s: any) => s.status === 'passed').length;
                // const failed = this.currentFeature.scenarios.filter((s: any) => s.status === 'failed').length;
                // const skipped = this.currentFeature.scenarios.filter((s: any) => s.status === 'skipped').length;
                // CSReporter.info(`[SCENARIO-COUNT] Status: ${passed} passed, ${failed} failed, ${skipped} skipped`);
            }

            CSReporter.endFeature();
            await this.context.cleanupFeature();
        }
    }
    
    private async executeScenario(scenario: ParsedScenario, feature: ParsedFeature, options: RunOptions): Promise<void> {
        // Handle scenario outline with examples
        if (scenario.examples) {
            CSReporter.debug(`Scenario ${scenario.name} has examples`);
            // Load external data if configured
            const examples = await this.loadExamplesData(scenario.examples);

            CSReporter.debug(`Examples loaded: ${examples.rows.length} rows`);
            if (examples.rows.length > 0) {
                // Track which columns are actually used in the scenario steps
                const usedColumns = this.findUsedColumnsInScenario(scenario, examples.headers);
                CSReporter.info(`📊 Data-driven test using ${usedColumns.size} of ${examples.headers.length} columns: ${Array.from(usedColumns).join(', ')}`);

                const adoIntegration = this.ensureADOIntegration();
                const dataDrivenResults: any[] = [];

                let iterationNumber = 1;
                for (const row of examples.rows) {
                    // Execute single scenario using the EXACT SAME method as parallel execution
                    // This is what parallel does: calls executeSingleScenarioForWorker which calls executeSingleScenario
                    // and returns a result object with error information
                    const scenarioResult = await this.executeSingleScenarioForWorker(
                        scenario,
                        feature,
                        options,
                        row,
                        examples.headers,
                        iterationNumber,
                        examples.rows.length
                    );

                    // Build clean iteration data using only the used columns (like before)
                    let iterationData: any = undefined;
                    if (row && examples.headers) {
                        // Get only the columns that are actually used in the scenario
                        const usedColumns = this.findUsedColumnsInScenario(scenario, examples.headers);
                        iterationData = {};
                        for (const header of usedColumns) {
                            const index = examples.headers.indexOf(header);
                            if (index >= 0) {
                                iterationData[header] = row[index];
                            }
                        }
                    }

                    // Now we have the EXACT same result structure as parallel execution
                    // Extract all the same fields that parallel uses
                    const result = {
                        scenario,
                        feature,
                        status: scenarioResult.status,
                        duration: scenarioResult.duration || 0,
                        artifacts: scenarioResult.artifacts || this.collectScenarioArtifacts(),
                        iteration: iterationNumber,
                        iterationData: iterationData, // Use the clean filtered data for comments
                        name: scenarioResult.name,
                        // Capture error information from scenarioResult - MUST use errorMessage field name!
                        errorMessage: scenarioResult.error || (scenarioResult.status === 'failed' ? 'Test failed' : undefined),
                        stackTrace: scenarioResult.stackTrace || scenarioResult.error  // Use error as stack if no separate stack
                    };

                    dataDrivenResults.push(result);
                    iterationNumber++;
                }

                // After all iterations, trigger ADO to publish aggregated results like parallel mode
                if (adoIntegration.getPublisher().isEnabled()) {
                    // Calculate overall status and collect failure information
                    const failedResults = dataDrivenResults.filter(r => r.status === 'failed');
                    const overallStatus = failedResults.length > 0 ? 'failed' : 'passed';
                    const totalDuration = dataDrivenResults.reduce((sum, r) => sum + r.duration, 0);

                    // Build aggregated error message if there are failures
                    let aggregatedError: string | undefined;
                    let aggregatedStack: string | undefined;
                    if (failedResults.length > 0) {
                        aggregatedError = `${failedResults.length} of ${dataDrivenResults.length} iterations failed`;

                        // Collect error details from each failed iteration
                        const errorDetails: string[] = [];
                        failedResults.forEach((result, index) => {
                            if (result.errorMessage || result.stackTrace) {
                                errorDetails.push(`Iteration ${result.iteration || index + 1}: ${result.errorMessage || 'Test failed'}`);
                            }
                        });

                        if (errorDetails.length > 0) {
                            aggregatedError += '. See comment for details.';
                            aggregatedStack = errorDetails.join('\n');
                        }
                    }

                    // Add all results to publisher for aggregation
                    for (const result of dataDrivenResults) {
                        adoIntegration.getPublisher().addScenarioResult(result);
                    }

                    // Trigger aggregated publishing with proper status and error info
                    await adoIntegration.afterScenario(
                        scenario,
                        feature,
                        overallStatus,
                        totalDuration,
                        aggregatedError,
                        undefined, // artifacts are handled per iteration
                        aggregatedStack
                    );
                }

            } else {
                CSReporter.warn(`No data rows for scenario: ${scenario.name}`);
            }
        } else {
            await this.executeSingleScenario(scenario, feature, options);
        }
    }

    private async executeSingleScenario(
        scenario: ParsedScenario,
        feature: ParsedFeature,
        options: RunOptions,
        exampleRow?: string[],
        exampleHeaders?: string[],
        iterationNumber?: number,
        totalIterations?: number,
        originalExamples?: any,
        usedColumns?: Set<string>,
        isRetryAttempt: boolean = false  // Track if this is a retry attempt
    ): Promise<void> {
        // Flag to track if we're going to retry (set in catch block, checked in finally block)
        let willRetryAfterFailure = false;

        // Clear any previous scenario error
        this.lastScenarioError = null;

        // Track scenario start time for accurate duration
        const scenarioStartTime = Date.now();

        let scenarioName = this.interpolateScenarioName(scenario.name, exampleRow, exampleHeaders);

        // Add iteration number to scenario name for data-driven tests
        if (iterationNumber && totalIterations && totalIterations > 1) {
            scenarioName = `${scenarioName}_Iteration-${iterationNumber}`;
        }
        
        CSReporter.startScenario(scenarioName);
        this.scenarioContext.setCurrentScenario(scenarioName);
        this.scenarioContext.setScenarioTags([...feature.tags, ...scenario.tags]);
        this.context.setCurrentScenario(scenarioName);

        // ADO: Before scenario hook
        const adoIntegration = this.ensureADOIntegration();
        adoIntegration.beforeScenario(scenario, feature);

        // INTELLIGENT MODULE DETECTION
        let requirements: ModuleRequirements;
        const moduleDetector = CSModuleDetector.getInstance();

        // Check if user explicitly specified modules via --modules flag
        const explicitModules = this.config.get('MODULES');

        if (explicitModules) {
            // User explicitly specified modules - override auto-detection
            const moduleList = explicitModules.split(',').map(m => m.trim().toLowerCase());
            requirements = {
                api: moduleList.includes('api'),
                database: moduleList.includes('database') || moduleList.includes('db'),
                soap: moduleList.includes('soap'),
                browser: moduleList.includes('ui') || moduleList.includes('browser')
            };
        } else {
            // Auto-detect required modules from scenario content
            requirements = moduleDetector.detectRequirements(scenario, feature);
        }

        // SELECTIVE STEP LOADING
        // Load only required step definitions
        const stepLoader = CSStepLoader.getInstance();
        await stepLoader.loadRequiredSteps(requirements);

        // CONDITIONAL BROWSER INITIALIZATION
        // Check if browser launch is required
        let browserLaunchRequired = this.config.getBoolean('BROWSER_LAUNCH_REQUIRED', true);

        // Use intelligent detection if enabled (default: true), otherwise fallback to legacy @api tag detection
        const moduleDetectionEnabled = this.config.getBoolean('MODULE_DETECTION_ENABLED', true);
        if (moduleDetectionEnabled) {
            // Use CSModuleDetector result
            browserLaunchRequired = moduleDetector.isBrowserRequired(requirements);

            // Log module detection result if logging enabled
            if (this.config.getBoolean('MODULE_DETECTION_LOGGING', false)) {
                const modules = moduleDetector.getRequirementsSummary(requirements);
                CSReporter.debug(`Intelligent Module Detection: ${modules} | Browser: ${browserLaunchRequired}`);
            }
        } else {
            // LEGACY: Enhanced API detection fallback (backward compatibility)
            if (browserLaunchRequired) {
                const allTags = [...(feature.tags || []), ...(scenario.tags || [])];
                const hasApiTag = allTags.some((tag: string) =>
                    tag === '@api' || tag === 'api' || tag.toLowerCase().includes('api')
                );

                if (hasApiTag) {
                    browserLaunchRequired = false;
                    CSReporter.info(`Detected @api tag - disabling browser for API-only test: ${scenarioName}`);
                }
            }
        }

        if (browserLaunchRequired) {
            // Create browser context and page for this scenario
            const browserManager = await this.ensureBrowserManager();
            await browserManager.launch();
            const browserContext = browserManager.getContext();
            const page = browserManager.getPage();

            await this.context.initialize(page, browserContext);
        } else {
            // Initialize context without browser for API-only tests
            await this.context.initialize(null, null);
        }
        
        try {
            // Execute before hooks
            await this.executeHooks('before', [...feature.tags, ...scenario.tags]);
            
            // Execute background steps if present
            if (feature.background) {
                CSReporter.debug(`Executing background with ${feature.background.steps.length} steps`);
                for (const step of feature.background.steps) {
                    await this.executeStep(step, options, exampleRow, exampleHeaders);
                }
            } else {
                CSReporter.debug('No background steps to execute');
            }
            
            // Execute scenario steps
            for (const step of scenario.steps) {
                await this.executeStep(step, options, exampleRow, exampleHeaders);
            }
            
            // DISABLED: Scenario-level screenshot on success
            // Screenshots are captured at step level only

            CSReporter.passScenario();
            await this.captureArtifactsIfNeeded('passed');

            // ADO: After scenario hook - passed
            const duration = Date.now() - scenarioStartTime;  // Calculate accurate duration from scenario start
            const artifacts = this.collectScenarioArtifacts();

            // Pass iteration data if this is a data-driven scenario
            let iterationData = exampleRow && exampleHeaders ?
                Object.fromEntries(exampleHeaders.map((h, i) => [h, exampleRow[i]])) : undefined;

            // Filter iteration data to only include used columns if provided
            if (iterationData && usedColumns && usedColumns.size > 0) {
                const filteredData: any = {};
                for (const [key, value] of Object.entries(iterationData)) {
                    if (usedColumns.has(key)) {
                        filteredData[key] = value;
                    }
                }
                iterationData = filteredData;
                CSReporter.debug(`Filtered iteration data to ${Object.keys(filteredData).length} used columns for ADO`);
            }

            // Skip ADO afterScenario for data-driven iterations (they're aggregated at the end)
            // Only call for non-data-driven scenarios (totalIterations === 0 means not data-driven)
            if (!totalIterations || totalIterations === 0) {
                await adoIntegration.afterScenario(scenario, feature, 'passed', duration, undefined, artifacts, undefined, iterationNumber, iterationData);
            }

        } catch (error: any) {
            // Store the error for ADO reporting
            this.lastScenarioError = error;

            CSReporter.failScenario(error.message);
            await this.captureArtifactsIfNeeded('failed');

            // DISABLED: Scenario-level screenshot on failure
            // Step-level screenshots are already captured for failures

            // Record video and HAR if enabled
            await this.captureFailureArtifacts();

            // INTELLIGENT RETRY LOGIC - Analyze failure before retrying
            if (options.retry && options.retry > 0) {
                // Analyze failure using diagnostics to determine if retry is worthwhile
                let shouldRetry = true; // Default to retry
                let failureAnalysis: any = null;

                try {
                    // Get failed step diagnostics from scenario context
                    const stepResults = this.scenarioContext.getStepResults();
                    const lastFailedStep = stepResults.filter(s => s.status === 'failed').pop();
                    const diagnostics = lastFailedStep?.diagnostics;

                    // Get current page for analysis
                    const page = this.browserManager?.getPage();
                    const currentUrl = page && !page.isClosed() ? await page.url().catch(() => 'unknown') : 'unknown';

                    // Perform failure analysis if we have page and CSIntelligentAI
                    if (page && !page.isClosed()) {
                        const { CSIntelligentAI } = await import('../ai/CSIntelligentAI');
                        const aiInstance = CSIntelligentAI.getInstance();

                        failureAnalysis = await aiInstance.analyzeFailure(error, {
                            step: lastFailedStep?.step || 'unknown',
                            page,
                            url: currentUrl || 'unknown'
                        });

                        CSReporter.debug(`[Retry] Failure analysis - Type: ${failureAnalysis.failureType}, Healable: ${failureAnalysis.healable}, Confidence: ${failureAnalysis.confidence.toFixed(2)}`);

                        // Record failure analysis in AI data for reports
                        CSReporter.recordAIFailureAnalysis({
                            failureType: failureAnalysis.failureType,
                            healable: failureAnalysis.healable,
                            confidence: failureAnalysis.confidence,
                            rootCause: failureAnalysis.rootCause,
                            suggestedStrategies: failureAnalysis.suggestedStrategies || [],
                            diagnosticInsights: failureAnalysis.diagnosticInsights || []
                        });

                        // Decision: Only retry if failure is healable
                        if (!failureAnalysis.healable) {
                            shouldRetry = false;
                            CSReporter.warn(`[Retry] Skipping retry - Failure type '${failureAnalysis.failureType}' is not healable`);
                            CSReporter.warn(`[Retry] Root cause: ${failureAnalysis.rootCause}`);

                            // Log diagnostic insights
                            if (failureAnalysis.diagnosticInsights && failureAnalysis.diagnosticInsights.length > 0) {
                                CSReporter.warn(`[Retry] Diagnostic insights:`);
                                failureAnalysis.diagnosticInsights.forEach((insight: string) => {
                                    CSReporter.warn(`  - ${insight}`);
                                });
                            }
                        } else {
                            CSReporter.info(`[Retry] Failure is healable - Type: ${failureAnalysis.failureType}`);
                            if (failureAnalysis.suggestedStrategies && failureAnalysis.suggestedStrategies.length > 0) {
                                CSReporter.info(`[Retry] Suggested strategies: ${failureAnalysis.suggestedStrategies.join(', ')}`);
                            }
                        }

                        // Additional intelligence: Check for non-retryable error patterns
                        const errorMsg = error.message.toLowerCase();
                        if (errorMsg.includes('network error') || errorMsg.includes('net::err_') ||
                            errorMsg.includes('500') || errorMsg.includes('503') ||
                            errorMsg.includes('econnrefused') || errorMsg.includes('enotfound')) {
                            shouldRetry = false;
                            CSReporter.warn(`[Retry] Skipping retry - Network/server error detected: ${error.message}`);
                        }

                        // Check diagnostics for fatal errors
                        if (diagnostics && diagnostics.stats) {
                            if (diagnostics.stats.totalErrors > 5) {
                                CSReporter.warn(`[Retry] Warning: ${diagnostics.stats.totalErrors} JavaScript errors detected on page`);
                            }
                            if (diagnostics.stats.failedRequests > 10) {
                                shouldRetry = false;
                                CSReporter.warn(`[Retry] Skipping retry - Too many failed requests (${diagnostics.stats.failedRequests}), likely server issue`);
                            }
                        }
                    }
                } catch (analysisError) {
                    // If analysis fails, default to retry (safe fallback)
                    CSReporter.debug(`[Retry] Failure analysis error: ${analysisError}, defaulting to retry`);
                    shouldRetry = true;
                }

                // Record retry decision in AI data for reports
                let retryReason = '';
                if (!shouldRetry && failureAnalysis) {
                    retryReason = `${failureAnalysis.failureType} is not healable - ${failureAnalysis.rootCause}`;
                } else if (!shouldRetry) {
                    retryReason = 'Non-retryable error pattern detected (network/server error)';
                } else if (failureAnalysis) {
                    retryReason = `${failureAnalysis.failureType} is healable - retry recommended`;
                } else {
                    retryReason = 'Default retry strategy';
                }

                CSReporter.recordAIRetryDecision({
                    shouldRetry,
                    reason: retryReason,
                    analysisUsed: failureAnalysis !== null
                });

                // Proceed with retry only if analysis recommends it
                if (shouldRetry) {
                    willRetryAfterFailure = true;  // Set flag so finally block knows not to add scenario
                    CSReporter.info(`Retrying scenario (attempt ${options.retry})...`);

                    // CRITICAL: Clear browser context before retry to avoid stale state
                    // This ensures login page loads correctly instead of staying logged in
                    try {
                        const browserManager = (await import('../browser/CSBrowserManager')).CSBrowserManager.getInstance();
                        const context = await browserManager.getContext();
                        if (context) {
                            CSReporter.debug('[Retry] Clearing browser context (cookies, storage, cache)...');
                            await context.clearCookies();
                            await context.clearPermissions();
                            // Clear local/session storage via page
                            const pages = context.pages();
                            for (const page of pages) {
                                await page.evaluate(() => {
                                    localStorage.clear();
                                    sessionStorage.clear();
                                }).catch(() => {});
                            }
                            CSReporter.debug('[Retry] Browser context cleared successfully');
                        }
                    } catch (e) {
                        CSReporter.debug(`[Retry] Could not clear browser context: ${e}`);
                    }

                    await this.executeSingleScenario(
                        scenario,
                        feature,
                        { ...options, retry: options.retry - 1 },
                        exampleRow,
                        exampleHeaders,
                        iterationNumber,
                        totalIterations,
                        originalExamples,
                        usedColumns,
                        true  // Mark as retry attempt
                    );
                    return; // Return after retry, don't throw
                } else {
                    // Don't retry - log detailed failure and continue to failure handling
                    CSReporter.error(`[Retry] Retry skipped based on failure analysis - scenario will fail`);
                }
            }

            // Log the error but don't throw it - let the scenario fail but continue with other scenarios
            CSReporter.error(`Scenario failed: ${scenarioName} - ${error.message}`);

            // Add to failed scenarios tracking
            this.failedScenarios.push({ scenario: scenarioName, feature: feature.name, error: error.message });
            this.anyTestFailed = true;  // Track that at least one test failed

            // ADO: After scenario hook - failed
            const duration = Date.now() - scenarioStartTime;  // Calculate accurate duration from scenario start
            const artifacts = this.collectScenarioArtifacts();
            const errorWithStack = {
                message: error.message || String(error),
                stack: error.stack || new Error().stack
            };

            // Pass iteration data if this is a data-driven scenario
            let iterationData = exampleRow && exampleHeaders ?
                Object.fromEntries(exampleHeaders.map((h, i) => [h, exampleRow[i]])) : undefined;

            // Filter iteration data to only include used columns if provided
            if (iterationData && usedColumns && usedColumns.size > 0) {
                const filteredData: any = {};
                for (const [key, value] of Object.entries(iterationData)) {
                    if (usedColumns.has(key)) {
                        filteredData[key] = value;
                    }
                }
                iterationData = filteredData;
                CSReporter.debug(`Filtered iteration data to ${Object.keys(filteredData).length} used columns for ADO`);
            }

            // Skip ADO afterScenario for data-driven iterations (they're aggregated at the end)
            // Only call for non-data-driven scenarios (totalIterations === 0 means not data-driven)
            if (!totalIterations || totalIterations === 0) {
                await adoIntegration.afterScenario(scenario, feature, 'failed', duration, errorWithStack.message, artifacts, errorWithStack.stack, iterationNumber, iterationData);
            }
            
        } finally {
            // Execute after hooks
            try {
                await this.executeHooks('after', [...feature.tags, ...scenario.tags]);
            } catch (hookError) {
                CSReporter.warn(`After hook failed but continuing: ${hookError}`);
            }
            
            // Collect test data from CSReporter and add to testSuite
            const reporterResults = CSReporter.getResults();
            let scenarioStatus: 'passed' | 'failed' = 'passed'; // Default to passed

            // Get scenario name (interpolated if data-driven)
            let scenarioName = scenario.name;
            if (exampleRow && exampleHeaders && iterationNumber) {
                scenarioName = `${this.interpolateScenarioName(scenario.name, exampleRow, exampleHeaders)}_Iteration-${iterationNumber}`;
            }

            if (reporterResults.length > 0) {
                const lastResult = reporterResults[reporterResults.length - 1];
                scenarioStatus = lastResult.status === 'pass' ? 'passed' : 'failed';
                
                // Convert CSReporter result to testSuite format
                const scenarioData: any = {
                    id: `scenario-${Date.now()}`,
                    name: lastResult.name,
                    description: '',
                    tags: [...feature.tags, ...scenario.tags].filter(tag => !tag.startsWith('@data-config:')),
                    status: lastResult.status === 'pass' ? 'passed' : lastResult.status === 'fail' ? 'failed' : 'skipped',
                    startTime: new Date(lastResult.timestamp),
                    endTime: new Date(Date.now()),
                    duration: lastResult.duration,
                    // Add test data for data-driven scenarios
                    testData: exampleRow && exampleHeaders ? {
                        headers: exampleHeaders,
                        values: exampleRow,
                        iterationNumber: iterationNumber,
                        totalIterations: totalIterations,
                        source: this.getDataSourceInfo(originalExamples),
                        usedColumns: this.getUsedColumns(scenario, exampleHeaders),
                        totalColumns: exampleHeaders.length
                    } : undefined,
                    // error: lastResult.error ? { message: lastResult.error } : undefined, // Remove error property for TestScenario compatibility
                    steps: lastResult.steps.map((step, index) => {
                        // Get screenshot from scenario context step results
                        const stepResults = this.scenarioContext.getStepResults();
                        const matchingStep = stepResults.find(sr => sr.step === step.name);

                        // Build attachments array with screenshots
                        const attachments: any[] = [];
                        const screenshotPath = matchingStep?.screenshot || step.screenshot;
                        if (screenshotPath) {
                            // For reports, use just the filename not full path
                            const screenshotFilename = typeof screenshotPath === 'string' ?
                                path.basename(screenshotPath) : screenshotPath;
                            attachments.push({
                                type: 'screenshot',
                                path: screenshotFilename,
                                title: `Step ${index + 1} Screenshot`
                            });
                        }

                        return {
                            id: `step-${Date.now()}-${index}`,
                            name: step.name,
                            keyword: step.name.split(' ')[0] || 'Given',
                            order: index + 1,
                            status: step.status === 'pass' ? 'passed' : step.status === 'fail' ? 'failed' : 'skipped',
                            startTime: new Date(step.timestamp),
                            endTime: new Date(Date.now()),
                            duration: step.duration,
                            error: step.error ? { message: step.error } : undefined,
                            logs: step.actions.map((action: any) => ({
                                level: action.status === 'pass' ? 'info' : 'error',
                                message: action.action,
                                timestamp: new Date(action.timestamp),
                                source: 'step-execution'
                            })),
                            attachments: attachments,
                            actions: step.actions.map((action: any) => ({
                                name: action.action,
                                status: action.status === 'pass' ? 'passed' : action.status === 'fail' ? 'failed' : 'skipped',
                                duration: action.duration,
                                timestamp: new Date(action.timestamp),
                                details: {}
                            })),
                            screenshot: screenshotPath,  // Keep original for backward compatibility
                            aiData: step.aiData,  // Include AI data from CSReporter
                            diagnostics: step.diagnostics  // Include diagnostics from CSReporter
                        };
                    })
                };

                // Only add to scenarios array if:
                // 1. We're NOT going to retry (willRetryAfterFailure=false), AND
                // 2. Either this is NOT a retry attempt OR this IS a retry and it's the final attempt
                const isFinalAttempt = !options.retry || options.retry === 0;
                if (this.currentFeature && !willRetryAfterFailure && (!isRetryAttempt || isFinalAttempt)) {
                    // Remove previous attempts if this is a final retry
                    if (isRetryAttempt && isFinalAttempt) {
                        // Remove previous attempts for this scenario (by matching name)
                        const scenarioName = scenarioData.name;
                        // CSReporter.debug(`[SCENARIO-TRACKING] Removing previous attempts of: ${scenarioName}`);
                        (this.currentFeature as any).scenarios = (this.currentFeature as any).scenarios.filter(
                            (s: any) => s.name !== scenarioName
                        );
                    }
                    // CSReporter.debug(`[SCENARIO-TRACKING] Adding scenario to report: ${scenarioData.name} (total: ${(this.currentFeature as any).scenarios.length + 1})`);
                    (this.currentFeature as any).scenarios.push(scenarioData);
                } else {
                    // CSReporter.debug(`[SCENARIO-TRACKING] NOT adding scenario (will retry or not final): ${scenarioData.name}`);
                }
            } else {
                // No CSReporter results, create scenario data from context
                // This ensures reports are generated even when CSReporter has no data
                const steps = this.scenarioContext.getStepResults();
                const artifacts = this.collectScenarioArtifacts();

                // Determine status from steps if no reporter results
                scenarioStatus = steps.some((s: any) => s.status === 'failed') ? 'failed' : 'passed';

                const scenarioData: any = {
                    id: `scenario-${Date.now()}`,
                    name: scenarioName,
                    description: '',
                    tags: [...feature.tags, ...scenario.tags].filter(tag => !tag.startsWith('@data-config:')),
                    status: scenarioStatus,
                    startTime: new Date(scenarioStartTime),
                    endTime: new Date(),
                    duration: Date.now() - scenarioStartTime,
                    testData: exampleRow && exampleHeaders ? {
                        headers: exampleHeaders,
                        values: exampleRow,
                        iterationNumber: iterationNumber,
                        totalIterations: totalIterations,
                        source: this.getDataSourceInfo(originalExamples),
                        usedColumns: this.getUsedColumns(scenario, exampleHeaders),
                        totalColumns: exampleHeaders.length
                    } : undefined,
                    steps: steps.map((step: any, index: number) => ({
                        id: `step-${index}`,
                        keyword: (step.step || step.name || '').split(' ')[0],
                        name: step.step || step.name,
                        text: step.step || step.name,
                        description: '',
                        order: index + 1,
                        status: step.status,
                        startTime: new Date(),
                        endTime: new Date(),
                        duration: step.duration || 0,
                        error: step.error ? { message: step.error } : undefined,
                        logs: [],
                        attachments: [],
                        actions: [],
                        screenshot: step.screenshot
                    })),
                    artifacts: artifacts
                };

                // Only add to scenarios array if:
                // 1. We're NOT going to retry (willRetryAfterFailure=false), AND
                // 2. Either this is NOT a retry attempt OR this IS a retry and it's the final attempt
                const isFinalAttempt = !options.retry || options.retry === 0;
                if (this.currentFeature && !willRetryAfterFailure && (!isRetryAttempt || isFinalAttempt)) {
                    // Remove previous attempts if this is a final retry
                    if (isRetryAttempt && isFinalAttempt) {
                        // Remove previous attempts for this scenario (by matching name)
                        const scenarioName = scenarioData.name;
                        // CSReporter.debug(`[SCENARIO-TRACKING] Removing previous attempts of: ${scenarioName} (fallback path)`);
                        (this.currentFeature as any).scenarios = (this.currentFeature as any).scenarios.filter(
                            (s: any) => s.name !== scenarioName
                        );
                    }
                    // CSReporter.debug(`[SCENARIO-TRACKING] Adding scenario to report (fallback path): ${scenarioData.name} (total: ${(this.currentFeature as any).scenarios.length + 1})`);
                    (this.currentFeature as any).scenarios.push(scenarioData);
                } else {
                    // CSReporter.debug(`[SCENARIO-TRACKING] NOT adding scenario (fallback path, will retry or not final): ${scenarioData.name}`);
                }
            }

            // Always perform cleanup tasks regardless of scenario result
            await this.performScenarioCleanup(options, scenarioStatus);

            // Clear step instance cache between scenarios to avoid state leakage
            const { clearStepInstanceCache } = require('./CSBDDDecorators');
            clearStepInstanceCache();

            // Clear API context to prevent state leaking between scenarios
            try {
                const { CSApiContextManager } = require('../api/context/CSApiContextManager');
                const apiContextManager = CSApiContextManager.getInstance();
                const apiContext = apiContextManager.getCurrentContext();
                if (apiContext) {
                    // Clear ALL state, not just variables
                    apiContext.clearVariables();
                    apiContext.clearHeaders();
                    apiContext.clearCookies();
                    apiContext.clearResponses();
                    apiContext.auth = null;
                    apiContext.baseUrl = '';
                    apiContext.timeout = 30000;
                    // Reset query params specifically
                    apiContext.setVariable('queryParams', {});
                    apiContext.setVariable('requestBody', null);
                    CSReporter.debug('API context fully reset');
                }

                // Also clear the API client's state
                const { CSAPIClient } = require('../api/CSAPIClient');
                const apiClient = new CSAPIClient();
                apiClient.clearAuthentication();
                apiClient.clearHeaders();
            } catch (e) {
                // API context might not be available in non-API tests
            }

            CSReporter.endScenario();
            await this.context.cleanupScenario();
        }
    }
    
    private async executeStep(
        step: ParsedStep,
        options: RunOptions,
        exampleRow?: string[],
        exampleHeaders?: string[]
    ): Promise<void> {
        // Store current iteration test data in context for access in step definitions
        // Available via {currentRow} in step text ({testData} also supported for backward compatibility)
        if (exampleRow && exampleHeaders) {
            // Parse JSON strings back to arrays/objects if they look like JSON
            const rowData = Object.fromEntries(exampleHeaders.map((h, i) => {
                const value = exampleRow[i];
                // Try to parse as JSON if it looks like an array or object
                if (typeof value === 'string' && (value.trim().startsWith('[') || value.trim().startsWith('{'))) {
                    try {
                        return [h, JSON.parse(value)];
                    } catch {
                        // If parse fails, use as string
                        return [h, value];
                    }
                }
                return [h, value];
            }));
            this.context.setVariable('currentRow', rowData);
            this.context.setVariable('testData', rowData); // Backward compatibility
        }

        const stepText = this.interpolateStepText(step.text, exampleRow, exampleHeaders);
        const stepStartTime = Date.now();

        this.context.setCurrentStep(`${step.keyword} ${stepText}`);
        CSReporter.startStep(`${step.keyword} ${stepText}`);
        
        try {
            // Execute before step hooks
            await this.executeHooks('beforeStep', []);
            
            // Convert data table if present
            const dataTable = step.dataTable ? new DataTable(step.dataTable) : undefined;

            // Set current step in scenario context for screenshot attachment
            this.scenarioContext.setCurrentStep(`${step.keyword} ${stepText}`);

            // Execute the step
            await executeStep(stepText, step.keyword.trim(), this.context, dataTable?.raw(), step.docString);
            
            const duration = Date.now() - stepStartTime;
            this.scenarioContext.addStepResult(`${step.keyword} ${stepText}`, 'passed', duration);
            
            // Capture screenshot on step success if enabled
            if (this.config.get('SCREENSHOT_CAPTURE_MODE', 'on-failure') === 'always' || 
                this.config.getBoolean('SCREENSHOT_ON_SUCCESS', false)) {
                await this.captureStepScreenshot(`${step.keyword} ${stepText}`);
            }
            
            CSReporter.passStep(duration);
            
        } catch (error: any) {
            const duration = Date.now() - stepStartTime;
            const stepFullText = `${step.keyword} ${stepText}`;

            // ATTEMPT AI HEALING (ONLY FOR UI STEPS)
            // AI automatically detects if this is a UI step and only activates healing for UI failures
            try {
                const aiIntegration = this.ensureAIIntegration();

                // Check if AI should activate for this step (UI-only by default)
                if (aiIntegration.shouldActivateAI(stepFullText)) {
                    CSReporter.debug(`[AI] Attempting intelligent healing for failed step: ${stepFullText}`);

                    // Extract locator from error message if possible
                    if (!CSLocatorExtractor) {
                        CSLocatorExtractor = require('../ai/utils/CSLocatorExtractor').CSLocatorExtractor;
                    }
                    const extractedLocator = CSLocatorExtractor.extract(error);
                    if (extractedLocator) {
                        CSReporter.debug(`[AI] Extracted locator from error: ${extractedLocator}`);
                    }

                    const healingResult = await aiIntegration.attemptHealing(error, {
                        page: this.browserManager ? this.browserManager.getPage() : null,
                        locator: extractedLocator || '', // Extracted from error or empty
                        step: stepFullText,
                        url: this.browserManager ? this.browserManager.getPage()?.url() : '',
                        testName: this.scenarioContext.getCurrentScenario(),
                        scenarioName: this.scenarioContext.getCurrentScenario()
                    });

                    if (healingResult.healed && healingResult.newLocator) {
                        CSReporter.info(`[AI] ✅ Healing successful! Retrying step with healed locator...`);

                        // Retry the step with the healed information
                        // Reset the timer for the retry
                        const retryStartTime = Date.now();

                        try {
                            // Re-execute the step - the healing has already updated internal state
                            await executeStep(stepText, step.keyword.trim(), this.context, undefined, step.docString);

                            const retryDuration = Date.now() - retryStartTime;
                            this.scenarioContext.addStepResult(stepFullText, 'passed', retryDuration);
                            CSReporter.passStep(retryDuration);

                            CSReporter.info(`[AI] Step passed after healing (retry duration: ${retryDuration}ms)`);
                            return; // SUCCESS - exit early, step passed after healing

                        } catch (retryError: any) {
                            CSReporter.debug(`[AI] Step still failed after healing, proceeding with normal error handling`);
                            // Fall through to normal error handling below
                        }
                    } else {
                        CSReporter.debug(`[AI] Healing unsuccessful, proceeding with normal error handling`);
                    }
                } else {
                    CSReporter.debug(`[AI] Skipped for non-UI step (API/Database steps use existing retry behavior)`);
                }
            } catch (aiError: any) {
                // AI healing failed, continue with normal error handling
                CSReporter.debug(`[AI] Error during healing attempt: ${aiError.message}`);
            }

            // NORMAL ERROR HANDLING (if AI healing didn't work or wasn't applicable)
            // Don't add step result yet - we need to capture screenshot first

            // Capture screenshot on step failure based on capture mode
            // Always capture on failure regardless of error type
            const screenshotCaptureMode = this.config.get('SCREENSHOT_CAPTURE_MODE', 'on-failure').toLowerCase();
            const shouldCaptureScreenshot = (
                screenshotCaptureMode === 'always' ||
                screenshotCaptureMode === 'on-failure' ||
                screenshotCaptureMode === 'on-failure-only'
            );

            if (shouldCaptureScreenshot && this.browserManager) {
                try {
                    const page = this.browserManager.getPage();

                    // Check if page is still valid and not closed
                    if (!page || page.isClosed()) {
                        CSReporter.warn('Page is closed or invalid - cannot take screenshot');
                    } else {
                        // Small wait to ensure any error messages are rendered
                        await page.waitForTimeout(100);

                        const dirs = this.resultsManager.getDirectories();
                        const screenshotDir = dirs.screenshots;
                        const fs = require('fs');
                        if (!fs.existsSync(screenshotDir)) {
                            fs.mkdirSync(screenshotDir, { recursive: true });
                        }
                        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                        const stepName = `${step.keyword}-${stepText}`.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50);
                        const filename = `step-failure-${stepName}-${timestamp}.png`;
                        const screenshotPath = `${screenshotDir}/${filename}`;
                        await page.screenshot({
                            path: screenshotPath,
                            fullPage: false
                        });
                        CSReporter.info(`Step failure screenshot: ${screenshotPath}`);
                        // Store the full path for artifact collection
                        this.scenarioContext.addScreenshot(screenshotPath, 'step-failure');

                        // Attach screenshot to current step using filename only for reports
                        this.scenarioContext.setCurrentStepScreenshot(filename);

                        // Also add to context for the report (if method exists)
                        if (typeof (this.context as any).addArtifact === 'function') {
                            (this.context as any).addArtifact('screenshot', screenshotPath, `Step Failure: ${step.keyword} ${stepText}`);
                        }
                    }
                } catch (screenshotError) {
                    CSReporter.debug(`Failed to capture step failure screenshot: ${screenshotError}`);
                }
            }

            // Collect diagnostic data using Playwright 1.56+ APIs (console logs, page errors, network requests)
            if (this.browserManager) {
                try {
                    const page = this.browserManager.getPage();
                    if (page && !page.isClosed()) {
                        const diagnostics = await CSPageDiagnostics.collectOnFailure(page);
                        if (diagnostics) {
                            CSReporter.debug(`Collected diagnostics: ${diagnostics.stats.totalLogs} logs, ${diagnostics.stats.totalErrors} errors, ${diagnostics.stats.totalRequests} requests`);
                            this.scenarioContext.setCurrentStepDiagnostics(diagnostics);
                        }
                    }
                } catch (diagnosticError) {
                    // Diagnostics collection should not break test execution
                    CSReporter.debug(`Failed to collect page diagnostics: ${diagnosticError}`);
                }
            }

            // Now add the step result after screenshot has been attached to currentStep
            this.scenarioContext.addStepResult(`${step.keyword} ${stepText}`, 'failed', duration);

            CSReporter.failStep(error.message, duration);
            throw error;
            
        } finally {
            // Execute after step hooks
            await this.executeHooks('afterStep', []);
            CSReporter.endStep('pass');

            // Clear current step after all processing is complete
            this.scenarioContext.clearCurrentStep();
        }
    }

    private findUsedColumnsInScenario(scenario: ParsedScenario, headers: string[]): Set<string> {
        const usedColumns = new Set<string>();

        // Check scenario name for placeholders
        const namePattern = /<([^>]+)>/g;
        let match;
        while ((match = namePattern.exec(scenario.name)) !== null) {
            if (headers.includes(match[1])) {
                usedColumns.add(match[1]);
            }
        }

        // Check all step texts for placeholders
        scenario.steps.forEach(step => {
            let stepMatch;
            const stepPattern = /<([^>]+)>/g;
            while ((stepMatch = stepPattern.exec(step.text)) !== null) {
                if (headers.includes(stepMatch[1])) {
                    usedColumns.add(stepMatch[1]);
                }
            }
        });

        return usedColumns;
    }

    private interpolateScenarioName(name: string, row?: string[], headers?: string[]): string {
        if (!row || !headers) return name;
        
        let interpolated = name;
        headers.forEach((header, index) => {
            interpolated = interpolated.replace(`<${header}>`, row[index]);
        });
        
        return interpolated;
    }
    
    private interpolateStepText(text: string, row?: string[], headers?: string[]): string {
        let interpolated = text;

        // First, replace <field> placeholders from Examples table
        if (row && headers) {
            headers.forEach((header, index) => {
                const value = row[index];
                // Validate: replacement value should not be the column name itself (data loading issue)
                if (value === header || value === header.toLowerCase() || value === header.toUpperCase()) {
                    CSReporter.warn(`[DATA WARNING] Column "${header}" has value "${value}" which matches the column name - possible data loading issue. Using empty string instead.`);
                    interpolated = interpolated.replace(`<${header}>`, '');
                } else {
                    interpolated = interpolated.replace(`<${header}>`, value);
                }
            });
        }

        // Second, call config.interpolate() to handle {config:}, {env:}, {currentRow}, etc.
        // Build context map with currentRow and testData for interpolation
        const contextMap = new Map<string, any>();
        const currentRow = this.context.getVariable('currentRow');
        const testData = this.context.getVariable('testData');
        if (currentRow !== undefined) {
            contextMap.set('currentRow', currentRow);
        }
        if (testData !== undefined) {
            contextMap.set('testData', testData);
        }

        interpolated = this.config.interpolate(interpolated, contextMap);

        // DEBUG: Log interpolation for troubleshooting config: values
        if (text.includes('{config:') && text !== interpolated) {
            CSReporter.debug(`Step interpolation: "${text}" => "${interpolated}"`);
        } else if (text.includes('{config:') && text === interpolated) {
            // Config value wasn't found/replaced
            const configPattern = /\{config:([^}]+)\}/g;
            let match;
            while ((match = configPattern.exec(text)) !== null) {
                const configKey = match[1];
                const configValue = this.config.get(configKey);
                CSReporter.warn(`Config interpolation failed for key "${configKey}" - value: ${configValue === undefined ? 'UNDEFINED' : `"${configValue}"`}`);
            }
        }

        return interpolated;
    }
    
    private async executeHooks(type: 'before' | 'after' | 'beforeStep' | 'afterStep', tags: string[]): Promise<void> {
        const hooks = getHooks(type, tags);
        
        for (const hook of hooks) {
            try {
                await hook.handler.call(this.context);
            } catch (error: any) {
                CSReporter.error(`Hook ${type} failed: ${error.message}`);
                throw error;
            }
        }
    }
    
    private async takeScreenshot(type: 'success' | 'failure'): Promise<void> {
        const timestamp = Date.now();
        const scenario = this.scenarioContext.getCurrentScenario() || 'unknown';
        const filename = `${scenario}_${type}_${timestamp}.png`;
        const filepath = path.join(process.cwd(), 'screenshots', filename);
        
        // Ensure directory exists
        const dir = path.dirname(filepath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        await this.context.page.screenshot({ path: filepath, fullPage: true });
        this.scenarioContext.addScreenshot(filepath, `${type} screenshot`);
        CSReporter.info(`Screenshot saved: ${filepath}`);
    }
    
    private hasLegacyFailures(): boolean {
        // Check if any scenario has failed (legacy method)
        return this.scenarioContext.getFailedSteps() > 0;
    }

    /**
     * Execute a single scenario for worker process
     * This method is called by worker processes in parallel execution
     */
    public async executeSingleScenarioForWorker(
        scenario: ParsedScenario,
        feature: ParsedFeature,
        options: RunOptions,
        exampleRow?: string[],
        exampleHeaders?: string[],
        iterationNumber?: number,
        totalIterations?: number
    ): Promise<any> {
        // Ensure feature has required properties
        if (!feature.tags) {
            feature.tags = [];
        }
        if (!scenario.tags) {
            scenario.tags = [];
        }

        // Initialize contexts
        this.featureContext.setCurrentFeature(feature.name);
        this.context.setCurrentFeature(feature.name);

        // Execute the scenario using existing method with data-driven parameters
        await this.executeSingleScenario(scenario, feature, options, exampleRow, exampleHeaders, iterationNumber, totalIterations, scenario.examples);

        // Get full results from CSReporter (same as sequential execution)
        const reporterResults = CSReporter.getResults();
        const lastResult = reporterResults.length > 0 ? reporterResults[reporterResults.length - 1] : null;

        // Get step results from scenario context for screenshots
        const stepResults = this.scenarioContext.getStepResults();

        // Interpolate scenario name with example data and add iteration number (same as sequential)
        let scenarioName = scenario.name;
        if (exampleRow && exampleHeaders) {
            scenarioName = this.interpolateScenarioName(scenario.name, exampleRow, exampleHeaders);
            if (iterationNumber && totalIterations && totalIterations > 1) {
                scenarioName = `${scenarioName}_Iteration-${iterationNumber}`;
            }
        }

        // Build complete scenario data (same structure as sequential)
        // Determine status first to use for error/stackTrace decision
        const scenarioStatus = this.currentScenario?.status || (lastResult?.status === 'pass' ? 'passed' : 'failed');

        const scenarioData = {
            name: scenarioName,
            feature: feature.name,
            tags: [...feature.tags, ...scenario.tags],
            status: scenarioStatus,
            duration: lastResult?.duration || 0,
            startTime: lastResult ? new Date(lastResult.timestamp) : new Date(),
            endTime: new Date(),
            // Add test data for data-driven scenarios (same as sequential)
            testData: exampleRow && exampleHeaders ? {
                headers: exampleHeaders,
                values: exampleRow,
                iterationNumber: iterationNumber,
                totalIterations: totalIterations,
                source: this.getDataSourceInfo(scenario.examples),
                usedColumns: this.getUsedColumns(scenario, exampleHeaders),
                totalColumns: exampleHeaders.length
            } : undefined,
            steps: lastResult ? lastResult.steps.map((step, index) => {
                // Find matching step result for screenshot
                const matchingStep = stepResults.find(sr => sr.step === step.name);

                return {
                    name: step.name,
                    keyword: step.name.split(' ')[0] || 'Given',
                    status: step.status === 'pass' ? 'passed' : step.status === 'fail' ? 'failed' : 'skipped',
                    duration: step.duration,
                    error: step.error ? { message: step.error } : undefined,
                    logs: step.actions.map(action => ({
                        level: action.status === 'pass' ? 'info' : 'error',
                        message: action.action,
                        timestamp: new Date(action.timestamp),
                        source: 'step-execution'
                    })),
                    actions: step.actions.map(action => ({
                        name: action.action,
                        status: action.status === 'pass' ? 'passed' : action.status === 'fail' ? 'failed' : 'skipped',
                        duration: action.duration,
                        timestamp: new Date(action.timestamp)
                    })),
                    screenshot: matchingStep?.screenshot || step.screenshot,
                    aiData: step.aiData,  // Include AI data from CSReporter
                    diagnostics: step.diagnostics  // Include diagnostics from CSReporter
                };
            }) : [],
            // Only extract error and stack trace if the scenario actually failed
            error: scenarioStatus === 'failed' ?
                (this.lastScenarioError?.message || lastResult?.steps?.find(s => s.status === 'fail')?.error || undefined) :
                undefined,
            // Extract stack trace only for failed scenarios
            stackTrace: scenarioStatus === 'failed' ?
                (this.lastScenarioError?.stack || lastResult?.steps?.find(s => s.status === 'fail')?.error || undefined) :
                undefined
        };

        // Get artifacts from browser manager (only if browser manager exists)
        const artifacts = this.browserManager ? await this.browserManager.getSessionArtifacts() : { screenshots: [], videos: [], traces: [], har: [] };

        // Get screenshots from scenario context and add to artifacts
        const scenarioScreenshots = this.scenarioContext.getScreenshots();
        if (scenarioScreenshots && scenarioScreenshots.length > 0) {
            // Add to artifacts.screenshots if not already present
            artifacts.screenshots = artifacts.screenshots || [];
            for (const screenshot of scenarioScreenshots) {
                const screenshotPath = typeof screenshot === 'object' ? screenshot.path : screenshot;
                if (screenshotPath && !artifacts.screenshots.includes(screenshotPath)) {
                    artifacts.screenshots.push(screenshotPath);
                }
            }
        }

        return {
            ...scenarioData,
            artifacts,
            // Include iteration info for ADO integration
            iterationNumber: iterationNumber,
            iterationData: exampleRow && exampleHeaders ?
                Object.fromEntries(exampleHeaders.map((h, i) => [h, exampleRow[i]])) : undefined
        };
    }

    /**
     * Load step definitions for a specific project
     * @param project - Project name
     * @param requirements - Optional module requirements for selective loading of framework steps
     */
    public async loadProjectSteps(project: string, requirements?: ModuleRequirements): Promise<void> {
        if (!project) return;

        // Get step definition paths from configuration
        const config = CSConfigurationManager.getInstance();
        const stepPaths = config.get('STEP_DEFINITIONS_PATH', 'test/common/steps;test/{project}/steps;test/{project}/step-definitions;src/steps');

        let paths: string[] = [];

        // Use configuration, split paths and replace {project} placeholder
        paths = stepPaths.split(';').map(p => p.trim().replace('{project}', project));

        let filesLoaded = false;
        for (const relativePath of paths) {
            const stepDir = path.join(process.cwd(), relativePath);
            if (fs.existsSync(stepDir)) {
                //check if this is a framework step path
                const isFrameworkPath = relativePath.includes('node_modules') && relativePath.includes('cs-playwright-test-framework');

                //Load step files recursively with selective filtering for framework paths
                filesLoaded = this.loadStepFilesRecursively(stepDir, isFrameworkPath, requirements) || filesLoaded;
            }
        }

        if (!filesLoaded) {
            CSReporter.warn(`No step definitions found for project: ${project} in paths: ${paths.join(', ')}`);
        }
    }

    /**
     * Recursively load step definition files from a directory
     * @param dir - Directory to scan
     * @param isFrameworkPath - Whether this is a framework step directory
     * @param requirements - Module requirements for selective loading (framework paths only)
     */
    private loadStepFilesRecursively(dir: string, isFrameworkPath: boolean = false, requirements?: ModuleRequirements): boolean {
        let filesLoaded = false;

        if (!fs.existsSync(dir)) {
            return false;
        }

        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {

                //Selective Loading: skip framework step groups that aren't required
                if(isFrameworkPath && requirements) {
                    const dirName = entry.name.toLowerCase();

                    //check if this directory should be skipped based on requirements
                    if(dirName === 'api' && !requirements.api){
                        CSReporter.debug(`[StepLoader] Skipping framework API steps (not required)`);
                        continue;
                    }
                    if(dirName === 'database' && !requirements.database){
                        CSReporter.debug(`[StepLoader] Skipping framework Database steps (not required)`);
                        continue;
                    }
                    if(dirName === 'soap' && !requirements.soap){
                        CSReporter.debug(`[StepLoader] Skipping framework SOAP steps (not required)`);
                        continue;
                    }
                    if(dirName === 'common'){
                        //Only load common if browser if required OR no other modules
                        const needsCommon = requirements.browser || (!requirements.api && !requirements.database && !requirements.soap);
                        if(!needsCommon){
                            CSReporter.debug(`[StepLoader] Skipping framework Common steps (not required for API/Database/SOAP-only tests)`);
                            continue;
                        }
                    }
                }

                // Recursively load from subdirectories
                filesLoaded = this.loadStepFilesRecursively(fullPath, isFrameworkPath, requirements) || filesLoaded;
            } else if (entry.isFile() && (entry.name.endsWith('.steps.ts') || entry.name.endsWith('.steps.js') || entry.name.endsWith('Steps.js') || entry.name.endsWith('Steps.ts'))) {
                try {
                    // If it's a TypeScript file and we're in compiled mode, load the JS version
                    let fileToLoad = fullPath;
                    if (fullPath.endsWith('.ts') && fullPath.includes('/src/')) {
                        // Convert src path to dist path for TypeScript files
                        fileToLoad = fullPath.replace('/src/', '/dist/').replace('.ts', '.js');
                    }

                    if (fs.existsSync(fileToLoad)) {
                        require(fileToLoad);
                        CSReporter.debug(`Loaded step file: ${fileToLoad}`);
                        filesLoaded = true;
                    } else {
                        // Fall back to original path if compiled version doesn't exist
                        require(fullPath);
                        CSReporter.debug(`Loaded step file: ${fullPath}`);
                        filesLoaded = true;
                    }
                } catch (e: any) {
                    CSReporter.warn(`Failed to load step file ${fullPath}: ${e.message}`);
                }
            }
        }

        return filesLoaded;
    }
    
    private async generateReports(reportTypes: string[]): Promise<void> {
        // Legacy report generation - will be removed in next version
        // Using new professional report generator instead
        CSReporter.debug('Legacy report generation skipped - using professional reports');
    }
    
    private async generateProfessionalReport(): Promise<void> {
        try {
            const dirs = this.resultsManager.getDirectories();
            const reportPath = path.join(dirs.reports);
            
            // Generate the professional HTML report
            // Convert testSuite to CSWorldClassReportGenerator format
            const worldClassSuite = {
                name: this.testSuite.name,
                scenarios: this.testSuite.features.flatMap((f: any) => f.scenarios.map((s: any) => ({
                    name: s.name,
                    status: s.status === 'broken' ? 'failed' : (s.status as 'passed' | 'failed' | 'skipped'),
                    feature: f.name,
                    tags: s.tags || [],
                    steps: s.steps.map((step: any) => ({
                        name: step.name,
                        status: step.status === 'pending' ? 'skipped' : (step.status as 'passed' | 'failed' | 'skipped'),
                        duration: step.duration,
                        error: step.error?.message,
                        logs: (step.logs || []).map((log: any) => `[${log.level}] ${log.message}`),
                        actions: (step as any).actions || [],
                        screenshot: (step as any).screenshot
                    })),
                    duration: s.duration,
                    startTime: s.startTime,
                    endTime: s.endTime,
                    testData: (s as any).testData  // Include test data for data-driven scenarios
                }))),
                startTime: this.testSuite.startTime,
                endTime: this.testSuite.endTime,
                duration: this.testSuite.duration,
                totalScenarios: (this.testSuite as any).totalScenarios,
                passedScenarios: (this.testSuite as any).passedScenarios,
                failedScenarios: (this.testSuite as any).failedScenarios
            };
            
            // Lazy load the report generator
            const { CSHtmlReportGenerator } = await import('../reporter/CSHtmlReportGeneration');
            await CSHtmlReportGenerator.generateReport(worldClassSuite, reportPath);
            // Log message is already printed inside generateReport method
        } catch (error) {
            CSReporter.error(`Failed to generate professional report: ${error}`);
        }
    }
    
    // DEPRECATED - Replaced by CSProfessionalReportGenerator
    private async generateHtmlReportLegacy(): Promise<void> {
        const reportDir = this.config.get('REPORTS_BASE_DIR', './reports');
        const reportPath = path.join(reportDir, 'index.html');
        
        // Ensure directory exists
        if (!fs.existsSync(reportDir)) {
            fs.mkdirSync(reportDir, { recursive: true });
        }
        
        const totalScenarios = this.scenarioContext.getTotalScenarios();
        const passedScenarios = totalScenarios - this.failedScenarios.length;
        const failedScenarios = this.failedScenarios.length;
        const passRate = totalScenarios > 0 ? ((passedScenarios / totalScenarios) * 100).toFixed(2) : '0';
        
        const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CS Playwright Test Automation Report</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1200px; margin: 0 auto; }
        .header { background: white; border-radius: 10px; padding: 30px; margin-bottom: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
        .header h1 { color: #333; margin-bottom: 10px; }
        .header .timestamp { color: #666; font-size: 14px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 20px; }
        .stat-card { background: white; border-radius: 10px; padding: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
        .stat-card h3 { color: #666; font-size: 14px; margin-bottom: 10px; }
        .stat-card .value { font-size: 32px; font-weight: bold; }
        .stat-card.passed .value { color: #10b981; }
        .stat-card.failed .value { color: #ef4444; }
        .stat-card.total .value { color: #6366f1; }
        .scenarios { background: white; border-radius: 10px; padding: 30px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); }
        .scenario { border-left: 4px solid #e5e7eb; padding: 15px; margin-bottom: 15px; background: #f9fafb; border-radius: 5px; }
        .scenario.passed { border-left-color: #10b981; }
        .scenario.failed { border-left-color: #ef4444; }
        .scenario-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
        .scenario-name { font-weight: 600; color: #333; }
        .scenario-status { padding: 5px 10px; border-radius: 5px; font-size: 12px; font-weight: 600; }
        .scenario-status.passed { background: #10b981; color: white; }
        .scenario-status.failed { background: #ef4444; color: white; }
        .error-message { background: #fee; padding: 10px; border-radius: 5px; margin-top: 10px; color: #991b1b; font-family: monospace; font-size: 12px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 CS Playwright Test Automation Report</h1>
            <div class="timestamp">Generated on ${new Date().toLocaleString()}</div>
        </div>
        
        <div class="stats">
            <div class="stat-card total">
                <h3>Total Scenarios</h3>
                <div class="value">${totalScenarios}</div>
            </div>
            <div class="stat-card passed">
                <h3>Passed</h3>
                <div class="value">${passedScenarios}</div>
            </div>
            <div class="stat-card failed">
                <h3>Failed</h3>
                <div class="value">${failedScenarios}</div>
            </div>
            <div class="stat-card">
                <h3>Pass Rate</h3>
                <div class="value">${passRate}%</div>
            </div>
        </div>
        
        <div class="scenarios">
            <h2 style="margin-bottom: 20px;">Scenario Results</h2>
            ${this.failedScenarios.map(s => `
            <div class="scenario failed">
                <div class="scenario-header">
                    <div class="scenario-name">${s.scenario} (${s.feature})</div>
                    <div class="scenario-status failed">FAILED</div>
                </div>
                <div class="error-message">${s.error}</div>
            </div>
            `).join('')}
        </div>
    </div>
</body>
</html>`;
        
        fs.writeFileSync(reportPath, htmlContent);
    }
    
    // DEPRECATED - Replaced by CSProfessionalReportGenerator
    private async generateJsonReportLegacy(): Promise<void> {
        const reportDir = this.config.get('REPORTS_BASE_DIR', './reports');
        const reportPath = path.join(reportDir, 'results.json');
        
        // Ensure directory exists
        if (!fs.existsSync(reportDir)) {
            fs.mkdirSync(reportDir, { recursive: true });
        }
        
        const report = {
            timestamp: new Date().toISOString(),
            summary: {
                total: this.scenarioContext.getTotalScenarios(),
                passed: this.scenarioContext.getTotalScenarios() - this.failedScenarios.length,
                failed: this.failedScenarios.length,
                passRate: this.scenarioContext.getTotalScenarios() > 0 
                    ? ((this.scenarioContext.getTotalScenarios() - this.failedScenarios.length) / this.scenarioContext.getTotalScenarios() * 100).toFixed(2) 
                    : '0'
            },
            failedScenarios: this.failedScenarios,
            screenshots: this.scenarioContext.getScreenshots(),
            duration: this.scenarioContext.getDuration()
        };
        
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        CSReporter.info(`JSON report generated: ${reportPath}`);
    }
    
    // DEPRECATED - Will be implemented in next version
    private async generateJunitReport(): Promise<void> {
        CSReporter.debug('JUnit report generation pending implementation');
    }
    
    // DEPRECATED - Will be implemented in next version
    private async generateAllureReport(): Promise<void> {
        CSReporter.debug('Allure report generation pending implementation');
    }
    
    private async captureFailureArtifacts(): Promise<void> {
        try {
            if (!this.browserManager) return;
            const page = this.browserManager.getPage();
            const context = this.browserManager.getContext();
            
            if (!page || !context) {
                CSReporter.debug('No page/context available for artifact capture');
                return;
            }
            
            // Capture screenshot on failure (disabled - using step-level screenshots instead)
            const screenshotOnFailure = false; // this.config.getBoolean('SCREENSHOT_ON_FAILURE', true);
            if (screenshotOnFailure) {
                try {
                    const dirs = this.resultsManager.getDirectories();
                    const screenshotDir = dirs.screenshots;
                    const fs = require('fs');
                    if (!fs.existsSync(screenshotDir)) {
                        fs.mkdirSync(screenshotDir, { recursive: true });
                    }
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const screenshotPath = `${screenshotDir}/failure-${timestamp}.png`;
                    await page.screenshot({ 
                        path: screenshotPath, 
                        fullPage: true 
                    });
                    CSReporter.info(`Screenshot captured: ${screenshotPath}`);
                    this.scenarioContext.addScreenshot(screenshotPath, 'failure');
                } catch (error) {
                    CSReporter.debug(`Failed to capture screenshot: ${error}`);
                }
            }
            
            // Note: Video, HAR, and Trace are saved automatically when context closes
            // We don't need to manually save them here
            // Just log information about what will be saved
            
            const videoMode = this.config.get('BROWSER_VIDEO', 'off');
            if (videoMode !== 'off') {
                try {
                    const video = page.video();
                    if (video) {
                        // Don't call saveAs() - let Playwright handle it when context closes
                        CSReporter.debug('Video recording will be saved when context closes');
                    }
                } catch (error) {
                    CSReporter.debug('No video available');
                }
            }
            
            const harCaptureMode = this.config.get('HAR_CAPTURE_MODE', 'never');
            if (harCaptureMode !== 'never') {
                CSReporter.debug(`HAR recording enabled (${harCaptureMode}), will be saved when context closes`);
            }

            const traceCaptureMode = this.config.get('TRACE_CAPTURE_MODE', 'never');
            if (traceCaptureMode !== 'never') {
                CSReporter.debug(`Trace recording enabled (${traceCaptureMode}), will be saved when context closes`);
            }
            
        } catch (error) {
            CSReporter.debug(`Failed to capture failure artifacts: ${error}`);
        }
    }
    
    private async performScenarioCleanup(options: RunOptions, testStatus?: 'passed' | 'failed'): Promise<void> {
        try {
            // DISABLED: Scenario-level screenshots to avoid duplicates
            // Screenshots are now captured at step level only when failures occur
            // This prevents duplicate screenshots for the same failure

            // Check if browser reuse is enabled
            const browserReuseEnabled = this.config.getBoolean('BROWSER_REUSE_ENABLED', false);
            const clearStateOnReuse = this.config.getBoolean('BROWSER_REUSE_CLEAR_STATE', true);
            const closeAfterScenarios = this.config.getNumber('BROWSER_REUSE_CLOSE_AFTER_SCENARIOS', 0);

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
                    CSReporter.debug(`Closing browser after ${this.scenarioCountForReuse} scenarios (BROWSER_REUSE_CLOSE_AFTER_SCENARIOS=${closeAfterScenarios})`);
                    await this.browserManager.close(testStatus);
                    this.scenarioCountForReuse = 0;
                } else {
                    // Save trace before clearing state (similar to how video/HAR work)
                    // This ensures traces are saved per-scenario even with browser reuse
                    // Make sure we pass the test status properly
                    const statusToPass = testStatus || 'passed'; // Default to passed if undefined
                    if (this.browserManager) {
                        await (this.browserManager as any).saveTraceIfNeeded?.(statusToPass);
                    }

                    // Keep browser open but clear state if configured
                    if (clearStateOnReuse) {
                        try {
                            CSReporter.info('BROWSER_REUSE_CLEAR_STATE=true: Starting browser state cleanup...');

                            // Get context and page
                            let context, page;
                            try {
                                if (this.browserManager) {
                                    context = this.browserManager.getContext();
                                    page = this.browserManager.getPage();
                                }
                                CSReporter.debug(`Got context: ${!!context}, Got page: ${!!page}`);
                            } catch (e) {
                                CSReporter.error(`Failed to get context/page: ${e}`);
                                throw e;
                            }

                            if (page && context) {
                                // Step 1: Navigate to about:blank first to leave the application
                                CSReporter.info('Navigating to about:blank to clear page state...');
                                await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });
                                CSReporter.info('Successfully navigated to about:blank');

                                // Step 2: Clear all cookies at context level
                                CSReporter.debug('Clearing all cookies...');
                                await context.clearCookies();

                                // Step 3: Clear permissions
                                CSReporter.debug('Clearing permissions...');
                                await context.clearPermissions();

                                // Step 4: Clear localStorage and sessionStorage via JavaScript
                                CSReporter.debug('Clearing localStorage and sessionStorage...');
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

                                CSReporter.info('✓ Browser state completely cleared for reuse');
                            } else {
                                CSReporter.error(`Context or page is null - context: ${!!context}, page: ${!!page}`);
                            }
                        } catch (error) {
                            CSReporter.error(`Failed to clear browser state: ${error}`);
                            // Don't throw - we want to continue even if cleanup fails
                        }
                    } else {
                        CSReporter.debug('Browser kept open for reuse (state not cleared)');
                    }

                    // Restart trace recording for the next scenario (after state is cleared)
                    await (this.browserManager as any).restartTraceForNextScenario?.();
                }
            } else {
                // Default behavior - close browser after each scenario
                try {
                    await this.browserManager.close(testStatus);
                    CSReporter.debug(`Browser closed after scenario (status: ${testStatus})`);
                } catch (error) {
                    CSReporter.debug('Browser already closed or failed to close');
                }
            }

            // ADO results are now uploaded via CSADOIntegration hooks

        } catch (error) {
            CSReporter.debug(`Failed during scenario cleanup: ${error}`);
        }
    }
    
    /**
     * Capture screenshot after each step execution
     */
    private async captureStepScreenshot(stepName: string): Promise<void> {
        try {
            if (!this.browserManager) return;
            const page = this.browserManager.getPage();
            if (!page) return;

            const dirs = this.resultsManager.getDirectories();
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const sanitizedStepName = stepName.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50);
            const filename = `step_${sanitizedStepName}_${timestamp}.png`;
            const filepath = path.join(dirs.screenshots, filename);

            await page.screenshot({
                path: filepath,
                fullPage: false  // Step screenshots don't need full page
            });

            // Add to scenario context for reporting - use basename like in backup framework
            const currentStep = this.scenarioContext.getCurrentStep();
            if (currentStep) {
                currentStep.screenshot = filename; // Store just filename, not full path
            }

            // Also add to scenario context screenshots collection
            this.scenarioContext.addScreenshot(filename, 'step-success');  // Store just filename for reports

            CSReporter.debug(`Step screenshot captured: ${filename}`);
        } catch (error) {
            CSReporter.debug(`Failed to capture step screenshot: ${error}`);
        }
    }

    /**
     * Capture screenshot at scenario end
     */
    private async captureScenarioScreenshot(status: 'success' | 'failure'): Promise<void> {
        try {
            if (!this.browserManager) return;
            const page = this.browserManager.getPage();
            if (!page) return;

            const dirs = this.resultsManager.getDirectories();
            const scenario = this.scenarioContext.getCurrentScenario() || 'unknown';
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const sanitizedScenario = scenario.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 50);
            const filename = `scenario_${sanitizedScenario}_${status}_${timestamp}.png`;
            const filepath = path.join(dirs.screenshots, filename);

            await page.screenshot({ 
                path: filepath, 
                fullPage: true  // Scenario screenshots should capture full page
            });

            this.scenarioContext.addScreenshot(filepath, `${status} screenshot`);
            CSReporter.info(`Scenario screenshot captured: ${filename}`);
        } catch (error) {
            CSReporter.debug(`Failed to capture scenario screenshot: ${error}`);
        }
    }

    
    // === DATA PROVIDER METHODS ===

    private async loadExamplesData(examples: ParsedExamples): Promise<ParsedExamples> {
        // If no external data source, return as is
        if (!examples.dataSource) {
            CSReporter.debug(`No external data source for examples: ${JSON.stringify(examples)}`);
            return examples;
        }

        const dataProvider = CSDataProvider.getInstance();
        const source = examples.dataSource;

        try {
            CSReporter.info(`Loading external data from ${source.type}: ${source.source}`);

            // Build data provider options
            const options: any = {
                source: source.source,
                type: source.type  // Add the type field
            };

            // Add type-specific options
            if (source.sheet) options.sheet = source.sheet;
            if (source.delimiter) options.delimiter = source.delimiter;
            if (source.filter) {
                // Parse and apply filter expression
                options.filter = this.createFilterFunction(source.filter);
                options.filterExpression = source.filter;  // Keep original for cache key
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

    private getDataSourceInfo(examples: any): any {
        if (!examples) return null;

        const sourceInfo: any = {};

        // Check for external data configuration in dataSource property
        if (examples.dataSource) {
            const ds = examples.dataSource;
            sourceInfo.type = ds.type || 'inline';
            sourceInfo.file = ds.source || ds.file;

            // Add specific info based on type
            if (ds.type === 'excel' || ds.type === 'xlsx') {
                sourceInfo.sheet = ds.sheet || 'Sheet1';
                sourceInfo.delimiter = ds.delimiter;
                sourceInfo.filter = ds.filter;
            } else if (ds.type === 'csv') {
                sourceInfo.delimiter = ds.delimiter || ',';
                sourceInfo.filter = ds.filter;
            } else if (ds.type === 'json' || ds.type === 'xml') {
                sourceInfo.filter = ds.filter;
            } else if (ds.type === 'database' || ds.type === 'db') {
                sourceInfo.query = ds.query;
                sourceInfo.connection = ds.connection || 'default';
                sourceInfo.filter = ds.filter;
            }
        } else if (examples.configuration) {
            // Fallback to configuration property if present
            try {
                const config = JSON.parse(examples.configuration);
                sourceInfo.type = config.type || 'inline';
                sourceInfo.file = config.source || config.file;

                // Add specific info based on type
                if (config.type === 'excel' || config.type === 'xlsx') {
                    sourceInfo.sheet = config.sheet || 'Sheet1';
                    sourceInfo.filter = config.filter;
                } else if (config.type === 'csv') {
                    sourceInfo.delimiter = config.delimiter || ',';
                    sourceInfo.filter = config.filter;
                } else if (config.type === 'database' || config.type === 'db') {
                    sourceInfo.query = config.query;
                    sourceInfo.connection = config.connection || 'default';
                    sourceInfo.filter = config.filter;
                }
            } catch (e) {
                // If not JSON, might be inline examples
                sourceInfo.type = 'inline';
            }
        } else {
            sourceInfo.type = 'inline';
        }

        return sourceInfo;
    }

    private getUsedColumns(scenario: ParsedScenario, headers: string[]): string[] {
        const usedColumns = new Set<string>();

        // Check scenario name for placeholders
        const scenarioText = scenario.name;
        headers.forEach(header => {
            if (scenarioText.includes(`<${header}>`)) {
                usedColumns.add(header);
            }
        });

        // Check all steps for placeholders
        scenario.steps.forEach(step => {
            headers.forEach(header => {
                if (step.text.includes(`<${header}>`)) {
                    usedColumns.add(header);
                }
            });
        });

        return Array.from(usedColumns);
    }

    private createFilterFunction(filterExpression: string): (row: any) => boolean {
        // Support various filter expressions:
        // - Simple equality: "status=active"
        // - Boolean values: "executeTest=true"
        // - Not equal: "status!=disabled"
        // - Contains: "tags~smoke"
        // - Starts with: "name^Test"
        // - Ends with: "email$@test.com"
        // - Greater than: "priority>3"
        // - Less than: "priority<5"
        // - In list: "role:Admin,User,Manager"
        // - Multiple conditions: "status=active&priority>2"
        // - OR conditions: "status=active|role=Admin"

        CSReporter.debug(`Creating filter function for expression: ${filterExpression}`);

        // Handle OR conditions (| or " OR ")
        if (filterExpression.includes('|') || / OR /i.test(filterExpression)) {
            // Split by | or " OR " (case-insensitive)
            const orConditions = filterExpression.split(/\||\s+OR\s+/i);
            const orFilters = orConditions.map(cond => this.createFilterFunction(cond.trim()));
            return (row: any) => orFilters.some(filter => filter(row));
        }

        // Handle AND conditions (& or " AND ")
        if (filterExpression.includes('&') || / AND /i.test(filterExpression)) {
            // Split by & or " AND " (case-insensitive)
            const andConditions = filterExpression.split(/&|\s+AND\s+/i);
            const andFilters = andConditions.map(cond => this.createFilterFunction(cond.trim()));
            return (row: any) => andFilters.every(filter => filter(row));
        }

        // Parse single condition
        // Check for different operators
        let key: string;
        let operator: string;
        let value: string;

        if (filterExpression.includes('!=')) {
            [key, value] = filterExpression.split('!=').map(s => s.trim());
            operator = '!=';
        } else if (filterExpression.includes('>=')) {
            [key, value] = filterExpression.split('>=').map(s => s.trim());
            operator = '>=';
        } else if (filterExpression.includes('<=')) {
            [key, value] = filterExpression.split('<=').map(s => s.trim());
            operator = '<=';
        } else if (filterExpression.includes('>')) {
            [key, value] = filterExpression.split('>').map(s => s.trim());
            operator = '>';
        } else if (filterExpression.includes('<')) {
            [key, value] = filterExpression.split('<').map(s => s.trim());
            operator = '<';
        } else if (filterExpression.includes('~')) {
            [key, value] = filterExpression.split('~').map(s => s.trim());
            operator = '~';
        } else if (filterExpression.includes('^')) {
            [key, value] = filterExpression.split('^').map(s => s.trim());
            operator = '^';
        } else if (filterExpression.includes('$')) {
            [key, value] = filterExpression.split('$').map(s => s.trim());
            operator = '$';
        } else if (filterExpression.includes(':')) {
            [key, value] = filterExpression.split(':').map(s => s.trim());
            operator = ':';
        } else if (filterExpression.includes('=')) {
            [key, value] = filterExpression.split('=').map(s => s.trim());
            operator = '=';
        } else {
            CSReporter.warn(`Invalid filter expression: ${filterExpression}`);
            return () => true; // Return all rows if filter is invalid
        }

        // Create filter function based on operator
        return (row: any) => {
            const rowValue = row[key];

            // Handle null/undefined
            if (rowValue === null || rowValue === undefined) {
                return value === 'null' || value === 'undefined' || value === '';
            }

            // Convert to appropriate types for comparison
            const rowStr = String(rowValue).toLowerCase();
            const valueStr = value.toLowerCase();

            switch (operator) {
                case '=':
                    // Handle boolean values
                    if (valueStr === 'true' || valueStr === 'false') {
                        return rowValue === (valueStr === 'true') || rowValue === valueStr;
                    }
                    return rowStr === valueStr;

                case '!=':
                    if (valueStr === 'true' || valueStr === 'false') {
                        return rowValue !== (valueStr === 'true') && rowValue !== valueStr;
                    }
                    return rowStr !== valueStr;

                case '~': // Contains
                    return rowStr.includes(valueStr);

                case '^': // Starts with
                    return rowStr.startsWith(valueStr);

                case '$': // Ends with
                    return rowStr.endsWith(valueStr);

                case '>': // Greater than
                    return Number(rowValue) > Number(value);

                case '<': // Less than
                    return Number(rowValue) < Number(value);

                case '>=': // Greater than or equal
                    return Number(rowValue) >= Number(value);

                case '<=': // Less than or equal
                    return Number(rowValue) <= Number(value);

                case ':': // In list
                    const allowedValues = value.split(',').map(v => v.trim().toLowerCase());
                    return allowedValues.includes(rowStr);

                default:
                    return true;
            }
        };
    }

    // === VALIDATION HELPER METHODS ===

    private getAllLoadedStepFiles(): string[] {
        const stepFiles: string[] = [];
        const stepPaths = this.config.get('STEP_DEFINITIONS_PATH', 'test/common/steps;test/{project}/steps');
        const project = this.config.get('PROJECT', 'common');

        // Parse and expand paths
        const paths = stepPaths.split(';').map(p => {
            // Replace {project} placeholder
            p = p.replace('{project}', project);
            // Resolve relative to CWD
            return path.resolve(process.cwd(), p);
        });

        // Find all step files
        for (const stepPath of paths) {
            if (fs.existsSync(stepPath)) {
                const stat = fs.statSync(stepPath);

                if (stat.isDirectory()) {
                    stepFiles.push(...this.findStepFiles(stepPath));
                } else if (stepPath.endsWith('.ts') || stepPath.endsWith('.js')) {
                    stepFiles.push(stepPath);
                }
            }
        }

        return stepFiles;
    }

    private findStepFiles(dirPath: string): string[] {
        const files: string[] = [];
        const items = fs.readdirSync(dirPath);

        for (const item of items) {
            const fullPath = path.join(dirPath, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                files.push(...this.findStepFiles(fullPath));
            } else if (item.endsWith('.ts') || item.endsWith('.js')) {
                files.push(fullPath);
            }
        }

        return files;
    }

    // === ARTIFACT CAPTURE METHODS ===

    private async captureArtifactsIfNeeded(status: 'passed' | 'failed'): Promise<void> {
        try {
            if (!this.browserManager) return;
            const page = this.browserManager.getPage();
            const context = this.browserManager.getContext();

            if (!page || !context) {
                CSReporter.debug('No page/context available for artifact capture');
                return;
            }

            // Check capture modes to determine what to log
            const videoCaptureMode = this.config.get('BROWSER_VIDEO', 'off').toLowerCase();
            const harCaptureMode = this.config.get('HAR_CAPTURE_MODE', 'never').toLowerCase();
            const traceCaptureMode = this.config.get('TRACE_CAPTURE_MODE', 'never').toLowerCase();

            // Determine if we should capture artifacts based on mode and status
            const shouldCaptureVideo = this.shouldCaptureArtifact(videoCaptureMode, status);
            const shouldCaptureHar = this.shouldCaptureArtifact(harCaptureMode, status);
            const shouldCaptureTrace = this.shouldCaptureArtifact(traceCaptureMode, status);

            // Log capture decisions
            CSReporter.debug(`Artifact capture for ${status} scenario:`);
            CSReporter.debug(`  Video: ${videoCaptureMode} => ${shouldCaptureVideo ? 'CAPTURE' : 'SKIP'}`);
            CSReporter.debug(`  HAR: ${harCaptureMode} => ${shouldCaptureHar ? 'CAPTURE' : 'SKIP'}`);
            CSReporter.debug(`  Trace: ${traceCaptureMode} => ${shouldCaptureTrace ? 'CAPTURE' : 'SKIP'}`);
            CSReporter.debug(`  Screenshot: Captured at step level only (no scenario-level capture)`)

            // Note: Video, HAR, and Trace are saved automatically when context closes
            // The browser manager will handle cleanup based on capture modes and test status

            if (shouldCaptureVideo) {
                try {
                    const video = page.video();
                    if (video) {
                        CSReporter.info(`Video recording will be saved (scenario ${status}, mode: ${videoCaptureMode})`);
                    }
                } catch (error) {
                    CSReporter.debug('No video available');
                }
            }

            if (shouldCaptureHar) {
                CSReporter.info(`HAR recording will be saved (scenario ${status}, mode: ${harCaptureMode})`);
            }

            if (shouldCaptureTrace) {
                CSReporter.info(`Trace will be saved (scenario ${status}, mode: ${traceCaptureMode})`);
            }

        } catch (error) {
            CSReporter.debug(`Failed to capture artifacts: ${error}`);
        }
    }

    private shouldCaptureArtifact(captureMode: string, status: 'passed' | 'failed'): boolean {
        switch(captureMode) {
            case 'always':
                return true;
            case 'on-failure-only':
                return status === 'failed';
            case 'on-pass-only':
                return status === 'passed';
            case 'never':
                return false;
            default:
                // Default to on-failure-only for backward compatibility
                return status === 'failed';
        }
    }

    public getFailedScenarios(): Array<{scenario: string, feature: string, error: string}> {
        return this.failedScenarios;
    }

    public hasFailures(): boolean {
        return this.anyTestFailed || this.failedScenarios.length > 0;
    }

    /**
     * Collect artifacts from the current scenario for ADO publishing
     */
    private collectScenarioArtifacts(): any {
        const artifacts: any = {
            screenshots: [],
            videos: [],
            har: [],
            traces: [],
            logs: []
        };

        try {
            // Get test results directory
            const resultsDir = this.resultsManager.getCurrentTestRunDir();
            if (!resultsDir) return artifacts;

            // Collect screenshots from scenario context
            const stepResults = this.scenarioContext.getStepResults();
            for (const stepResult of stepResults) {
                if (stepResult.screenshot && fs.existsSync(stepResult.screenshot)) {
                    artifacts.screenshots.push(stepResult.screenshot);
                }
            }

            // Collect video if exists
            const videoPath = path.join(resultsDir, 'videos');
            if (fs.existsSync(videoPath)) {
                const videoFiles = fs.readdirSync(videoPath).filter(f => f.endsWith('.webm'));
                artifacts.videos.push(...videoFiles.map(f => path.join(videoPath, f)));
            }

            // Collect HAR files
            const harPath = path.join(resultsDir, 'har');
            if (fs.existsSync(harPath)) {
                const harFiles = fs.readdirSync(harPath).filter(f => f.endsWith('.har'));
                artifacts.har.push(...harFiles.map(f => path.join(harPath, f)));
            }

            // Collect trace files
            const tracePath = path.join(resultsDir, 'traces');
            if (fs.existsSync(tracePath)) {
                const traceFiles = fs.readdirSync(tracePath).filter(f => f.endsWith('.zip'));
                artifacts.traces.push(...traceFiles.map(f => path.join(tracePath, f)));
            }

            // Collect log files
            const logsPath = path.join(resultsDir, 'logs');
            if (fs.existsSync(logsPath)) {
                const logFiles = fs.readdirSync(logsPath).filter(f => f.endsWith('.log'));
                artifacts.logs.push(...logFiles.map(f => path.join(logsPath, f)));
            }
        } catch (error) {
            CSReporter.debug(`Error collecting scenario artifacts: ${error}`);
        }

        return artifacts;
    }
}