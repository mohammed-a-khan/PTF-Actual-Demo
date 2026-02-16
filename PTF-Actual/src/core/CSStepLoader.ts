/**
 * Selective Step Definition Loader
 *
 * Loads only the step definitions required for test scenarios,
 * reducing startup time and memory usage.
 *
 * Thread-Safe: Uses worker-aware singleton pattern for parallel execution
 * Caching: Tracks loaded groups per worker for efficient reuse
 */

import * as path from 'path';
import * as fs from 'fs';
import { ModuleRequirements } from './CSModuleDetector';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from './CSConfigurationManager';
import type { ParsedFeature } from '../bdd/CSBDDTypes'

export type StepGroup = 'common' | 'api' | 'database' | 'soap' | 'browser' | 'ai' | 'auth';

export class CSStepLoader {
    private static instance: CSStepLoader;
    private static workerInstances: Map<number, CSStepLoader> = new Map();
    private loadedGroups: Set<StepGroup> = new Set();
    private config: CSConfigurationManager;
    private frameworkRoot: string;

    // No hardcoded step groups - framework discovers step files automatically
    // by scanning dist/steps/{groupName}/ directories

    private constructor() {
        this.config = CSConfigurationManager.getInstance();

        // Detect framework root directory
        // When installed as dependency: node_modules/cs-playwright-test-framework/
        // When in development: current project root
        this.frameworkRoot = this.detectFrameworkRoot();
    }

    /**
     * Detect the framework's root directory
     * Handles both node_modules installation and development scenarios
     */
    private detectFrameworkRoot(): string {
        // Try to find the framework's package.json
        try {
            // __dirname in compiled code points to dist/core/
            // Go up to find the framework root
            const thisFileDir = __dirname; // e.g., /path/to/node_modules/@scope/framework/dist/core

            // Check if we're in dist/core (compiled framework)
            if (thisFileDir.includes('dist/core') || thisFileDir.includes('dist\\core')) {
                // Go up two levels: dist/core -> dist -> framework-root
                const frameworkRoot = path.resolve(thisFileDir, '../..');

                // Verify this is the framework by checking package.json and framework structure
                const packageJsonPath = path.join(frameworkRoot, 'package.json');
                const stepsDir = path.join(frameworkRoot, 'dist', 'steps');
                if (fs.existsSync(packageJsonPath) && fs.existsSync(stepsDir)) {
                    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                    // Accept any package name containing 'cs-playwright-test-framework'
                    if (pkg.name && pkg.name.includes('cs-playwright-test-framework')) {
                        CSReporter.debug(`Framework root detected: ${frameworkRoot} (${pkg.name})`);
                        return frameworkRoot;
                    }
                }
            }

            // Fallback: Try to find package.json by walking up from __dirname
            // This handles cases where the package is installed in node_modules
            let currentDir = thisFileDir;
            for (let i = 0; i < 5; i++) { // Max 5 levels up
                const packageJsonPath = path.join(currentDir, 'package.json');
                if (fs.existsSync(packageJsonPath)) {
                    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                    if (pkg.name && pkg.name.includes('cs-playwright-test-framework')) {
                        CSReporter.debug(`Framework root resolved: ${currentDir} (${pkg.name})`);
                        return currentDir;
                    }
                }
                currentDir = path.dirname(currentDir);
            }
        } catch (error) {
            CSReporter.debug(`Framework root detection fallback to cwd: ${error}`);
        }

        // Fallback to current working directory (development mode)
        return process.cwd();
    }

    /**
     * Worker-aware singleton pattern
     * Each worker process gets its own instance with independent cache
     */
    public static getInstance(): CSStepLoader {
        // Check if running in worker thread
        if (typeof process !== 'undefined' && process.env.WORKER_ID) {
            const workerId = parseInt(process.env.WORKER_ID);
            if (!CSStepLoader.workerInstances.has(workerId)) {
                CSStepLoader.workerInstances.set(workerId, new CSStepLoader());
            }
            return CSStepLoader.workerInstances.get(workerId)!;
        }

        // Main thread singleton
        if (!CSStepLoader.instance) {
            CSStepLoader.instance = new CSStepLoader();
        }
        return CSStepLoader.instance;
    }

    /**
     * Load only the step definitions required for given modules
     * OPTIMIZED: Simplified logic, removed unnecessary scanning
     *
     * @param requirements - Module requirements from CSModuleDetector
     * @param features - Optional parsed features for file-level filtering
     */
    public async loadRequiredSteps(requirements: ModuleRequirements, features?: ParsedFeature[]): Promise<void> {
        const startTime = Date.now();

        // AI steps are ALWAYS loaded unconditionally - available to every consumer
        // regardless of STEP_DEFINITIONS_PATH or module detection settings
        if (!this.loadedGroups.has('ai')) {
            try {
                const aiLoaded = await this.loadStepGroup('ai');
                if (aiLoaded.length > 0) {
                    CSReporter.debug(`[StepLoader] AI steps loaded: ${aiLoaded.length} file(s)`);
                }
            } catch (error: any) {
                CSReporter.debug(`[StepLoader] AI steps not available: ${error.message}`);
            }
        }

        // Auth steps are ALWAYS loaded unconditionally - SSO login steps
        // must be available to any consumer that needs authentication flows
        if (!this.loadedGroups.has('auth')) {
            try {
                const authLoaded = await this.loadStepGroup('auth');
                if (authLoaded.length > 0) {
                    CSReporter.debug(`[StepLoader] Auth steps loaded: ${authLoaded.length} file(s)`);
                }
            } catch (error: any) {
                CSReporter.debug(`[StepLoader] Auth steps not available: ${error.message}`);
            }
        }

        // Check if framework steps should be loaded based on STEP_DEFINITIONS_PATH
        const stepPaths = this.config.get('STEP_DEFINITIONS_PATH', '');

        // Check if STEP_DEFINITIONS_PATH contains any framework-related paths
        const shouldLoadFrameworkSteps = stepPaths.includes('node_modules') &&
                                         stepPaths.includes('cs-playwright-test-framework');

        if (!shouldLoadFrameworkSteps) {
            CSReporter.debug('[StepLoader] Framework steps not in STEP_DEFINITIONS_PATH, skipping');
            return;
        }

        // Determine which step groups to load
        const groupsToLoad: StepGroup[] = [];
        const filesLoaded: string[] = [];

        // Check if explicit modules were specified
        const explicitModules = this.config.get('MODULES');

        if (explicitModules) {
            // User explicitly specified modules
            const moduleList = explicitModules.split(',').map(m => m.trim().toLowerCase());
            if (moduleList.includes('common') || moduleList.includes('ui') || moduleList.includes('browser')) {
                groupsToLoad.push('common');
            }
            if (moduleList.includes('api')) groupsToLoad.push('api');
            if (moduleList.includes('database') || moduleList.includes('db')) groupsToLoad.push('database');
            if (moduleList.includes('soap')) groupsToLoad.push('soap');
        } else {
            // Auto-detect based on requirements
            // Always load common steps for browser/UI tests or when no specific module is detected
            const needsCommon = requirements.browser || (!requirements.api && !requirements.database && !requirements.soap);
            if (needsCommon) groupsToLoad.push('common');
            if (requirements.api) groupsToLoad.push('api');
            if (requirements.database) groupsToLoad.push('database');
            if (requirements.soap) groupsToLoad.push('soap');
        }

        // Filter out already loaded groups
        const newGroups = groupsToLoad.filter(g => !this.loadedGroups.has(g));

        if (newGroups.length === 0) {
            CSReporter.debug('[StepLoader] All required framework step groups already loaded');
            return;
        }

        CSReporter.info(`[StepLoader] Loading framework step groups: ${newGroups.join(', ')}`);

        // Load each required group
        for (const group of newGroups) {
            const loaded = await this.loadStepGroup(group);
            filesLoaded.push(...loaded);
        }

        const duration = Date.now() - startTime;
        const workerId = process.env.WORKER_ID ? `Worker ${process.env.WORKER_ID}` : 'Main';
        CSReporter.info(`[${workerId}] ✅ Loaded ${filesLoaded.length} framework step files in ${duration}ms`);
    }

    /**
     * Load all step definitions for a specific group by scanning its directory
     * OPTIMIZED: Fast loading without expensive file content analysis
     * @param groupName - The step group to load (api, database, common, soap, browser)
     * @param stepPatterns - Optional step patterns (IGNORED for performance - loads all files)
     * @returns Array of loaded file names
     */
    private async loadStepGroup(groupName: StepGroup, stepPatterns?: Set<string>): Promise<string[]> {
        const startTime = Date.now();
        const loadedFiles: string[] = [];

        // Determine the directory to scan
        // Try dist/steps/{groupName}/ first (compiled), then src/steps/{groupName}/ (dev mode)
        const distDir = path.join(this.frameworkRoot, 'dist', 'steps', groupName);
        const srcDir = path.join(this.frameworkRoot, 'src', 'steps', groupName);

        let stepDir = distDir;

        if (!fs.existsSync(distDir)) {
            if (fs.existsSync(srcDir)) {
                stepDir = srcDir;
            } else {
                this.loadedGroups.add(groupName);
                return loadedFiles;
            }
        }

        // Read all files in the directory (single I/O operation)
        try {
            const entries = fs.readdirSync(stepDir, { withFileTypes: true });

            // Filter to step files only
            const stepFiles = entries.filter(entry =>
                entry.isFile() && this.isStepFile(entry.name)
            );

            if (stepFiles.length === 0) {
                this.loadedGroups.add(groupName);
                return loadedFiles;
            }

            CSReporter.debug(`[StepLoader] Loading ${stepFiles.length} ${groupName} step files...`);

            // PERFORMANCE OPTIMIZATION: Load all step files
            // Note: require() is synchronous but very fast for compiled JS files
            // The bottleneck is usually decorator registration, not file loading
            for (const entry of stepFiles) {
                const fullPath = path.join(stepDir, entry.name);
                try {
                    // Check if module is already in cache
                    if (require.cache[require.resolve(fullPath)]) {
                        loadedFiles.push(fullPath);
                        continue;
                    }

                    require(fullPath);
                    loadedFiles.push(fullPath);
                } catch (error: any) {
                    CSReporter.error(`Failed to load ${entry.name}: ${error.message}`);
                }
            }

            const duration = Date.now() - startTime;
            CSReporter.debug(`[StepLoader] Loaded ${loadedFiles.length} ${groupName} step files (${duration}ms)`);

        } catch (error: any) {
            CSReporter.error(`Failed to read step directory ${stepDir}: ${error.message}`);
        }

        this.loadedGroups.add(groupName);
        return loadedFiles;
    }

    /**
     * Check if a step group is loaded
     */
    public isGroupLoaded(group: StepGroup): boolean {
        return this.loadedGroups.has(group);
    }

    /**
     * Get all loaded groups
     */
    public getLoadedGroups(): StepGroup[] {
        return Array.from(this.loadedGroups);
    }

    /**
     * Reset loaded groups (for testing)
     */
    public reset(): void {
        this.loadedGroups.clear();
    }

    /**
     * Load steps for a specific project with selective loading based on feature files
     * OPTIMIZED: Removed expensive pattern matching - now just loads all discovered step files
     *
     * @param project - Project name
     * @param featureFiles - Array of feature file paths (not used anymore - kept for API compatibility)
     * @param stepPaths - Custom step paths (optional)
     */
    public async loadSelectiveProjectSteps(
        project: string,
        featureFiles: string[] = [],
        stepPaths?: string
    ): Promise<void> {
        // Just delegate to loadProjectSteps - no more expensive pattern matching
        return this.loadProjectSteps(project, stepPaths);
    }

    /**
     * Load steps for a specific project
     * OPTIMIZED: Simplified - removed cache complexity, uses direct loading
     *
     * @param project - Project name
     * @param stepPaths - Custom step paths (optional)
     */
    public async loadProjectSteps(project: string, stepPaths?: string): Promise<void> {
        if (!project) return;

        const startTime = Date.now();

        const paths = stepPaths || this.config.get(
            'STEP_DEFINITIONS_PATH',
            'test/common/steps;test/{project}/steps;test/{project}/step-definitions;src/steps'
        );

        // Parse and expand paths
        const expandedPaths = paths
            .split(';')
            .map(p => p.trim().replace('{project}', project))
            .map(p => path.resolve(process.cwd(), p));

        const loadedFilePaths: string[] = [];

        for (const stepDir of expandedPaths) {
            // Skip framework paths - handled separately
            if (stepDir.includes('node_modules') && stepDir.includes('cs-playwright-test-framework')) {
                continue;
            }

            if (fs.existsSync(stepDir)) {
                this.loadStepFilesRecursively(stepDir, loadedFilePaths);
            }
        }

        const duration = Date.now() - startTime;
        const workerId = process.env.WORKER_ID ? `Worker ${process.env.WORKER_ID}` : 'Main';

        if (loadedFilePaths.length > 0) {
            CSReporter.info(`[${workerId}] ✅ Loaded ${loadedFilePaths.length} project step files in ${duration}ms`);
        } else {
            CSReporter.debug(`[${workerId}] No project step definitions found in: ${expandedPaths.join(', ')}`);
        }
    }

    /**
     * Recursively load step definition files from a directory
     */
    private loadStepFilesRecursively(dir: string, loadedFilePaths?: string[]): boolean {
        let filesLoaded = false;

        if (!fs.existsSync(dir)) {
            return false;
        }

        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                // Recursively load from subdirectories
                filesLoaded = this.loadStepFilesRecursively(fullPath, loadedFilePaths) || filesLoaded;
            } else if (entry.isFile() && this.isStepFile(entry.name)) {
                try {
                    // Handle TypeScript vs JavaScript
                    let fileToLoad = fullPath;
                    if (fullPath.endsWith('.ts') && fullPath.includes('/src/')) {
                        const distPath = fullPath.replace('/src/', '/dist/').replace('.ts', '.js');
                        if (fs.existsSync(distPath)) {
                            fileToLoad = distPath;
                        }
                    }

                    if (fs.existsSync(fileToLoad)) {
                        require(fileToLoad);
                        CSReporter.debug(`Loaded step file: ${fileToLoad}`);
                        filesLoaded = true;
                        if (loadedFilePaths) {
                            loadedFilePaths.push(fileToLoad);
                        }
                    } else {
                        require(fullPath);
                        CSReporter.debug(`Loaded step file: ${fullPath}`);
                        filesLoaded = true;
                        if (loadedFilePaths) {
                            loadedFilePaths.push(fullPath);
                        }
                    }
                } catch (e: any) {
                    CSReporter.warn(`Failed to load step file ${fullPath}: ${e.message}`);
                }
            }
        }

        return filesLoaded;
    }

    /**
     * Check if a file is a step definition file
     */
    private isStepFile(filename: string): boolean {
        return (
            filename.endsWith('.steps.ts') ||
            filename.endsWith('.steps.js') ||
            filename.endsWith('Steps.js') ||
            filename.endsWith('Steps.ts')
        );
    }
}
