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
import type {ParsedFeature } from '../bdd/CSBDDTypes'

export type StepGroup = 'common' | 'api' | 'database' | 'soap' | 'browser';

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
     *
     * @param requirements - Module requirements from CSModuleDetector
     * @param features - Optional parsed features for file-level filtering
     */
    public async loadRequiredSteps(requirements: ModuleRequirements, features?: ParsedFeature[]): Promise<void> {
        // Check if framework steps should be loaded based on STEP_DEFINITIONS_PATH
        // Users control which framework steps to load via STEP_DEFINITIONS_PATH config
        const stepPaths = this.config.get('STEP_DEFINITIONS_PATH', '');

        // Check if STEP_DEFINITIONS_PATH contains any framework-related paths
        // Support both regular and scoped package names (e.g., @scope/package)
        const shouldLoadFrameworkSteps = stepPaths.includes('node_modules') &&
                                         stepPaths.includes('cs-playwright-test-framework');

        if (!shouldLoadFrameworkSteps) {
            CSReporter.debug('[StepLoader] Framework steps not in STEP_DEFINITIONS_PATH, skipping framework step loading');
            return;
        }

        // Use the same SELECTIVE_STEP_LOADING config as CSBDDEngine for consistency
        let useSelectiveLoading = this.config.getBoolean('SELECTIVE_STEP_LOADING', true);

        // If explicit modules were specified via --modules flag, force selective loading
        const explicitModules = this.config.get('MODULES');
        if (explicitModules) {
            useSelectiveLoading = true;
            CSReporter.debug(`[StepLoader] Explicit modules specified (${explicitModules}), forcing selective loading`);
        }

        const startTime = Date.now();
        let groupsLoaded: StepGroup[] = [];
        const filesLoaded: string[] = [];

        CSReporter.info('[StepLoader] Loading framework step definitions...');

        if (useSelectiveLoading) {
            // SELECTIVE LOADING: Only load required step groups
            // Always load common steps (contains browser/UI steps)

            const needsCommon = requirements.browser || (!requirements.api && !requirements.database && !requirements.soap);

            if (needsCommon && !this.loadedGroups.has('common')) {
                const loaded = await this.loadStepGroup('common');
                filesLoaded.push(...loaded);
                groupsLoaded.push('common');
            }

            // Load API steps if required
            if (requirements.api && !this.loadedGroups.has('api')) {
                const loaded = await this.loadStepGroup('api');
                filesLoaded.push(...loaded);
                groupsLoaded.push('api');
            }

            // Load Database steps if required
            if (requirements.database && !this.loadedGroups.has('database')) {
                const loaded = await this.loadStepGroup('database');
                filesLoaded.push(...loaded);
                groupsLoaded.push('database');
            }

            // Load SOAP steps if required
            if (requirements.soap && !this.loadedGroups.has('soap')) {
                const loaded = await this.loadStepGroup('soap');
                filesLoaded.push(...loaded);
                groupsLoaded.push('soap');
            }
        } else {
            // ALL STRATEGY: Load all framework step groups
            const allGroups: StepGroup[] = ['common', 'api', 'database', 'soap'];
            for (const group of allGroups) {
                if (!this.loadedGroups.has(group)) {
                    const loaded = await this.loadStepGroup(group);
                    filesLoaded.push(...loaded);
                    groupsLoaded.push(group);
                }
            }
        }

        // Always log results
        if (groupsLoaded.length > 0) {
            const duration = Date.now() - startTime;
            const workerId = process.env.WORKER_ID ? `Worker ${process.env.WORKER_ID}` : 'Main';
            CSReporter.info(`[${workerId}] ✅ Loaded ${filesLoaded.length} framework step files in ${duration}ms`);
        }
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
                        loadedFiles.push(entry.name);
                        continue;
                    }

                    require(fullPath);
                    loadedFiles.push(entry.name);
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
     *
     * @param project - Project name
     * @param featureFiles - Array of feature file paths to analyze
     * @param stepPaths - Custom step paths (optional)
     */
    public async loadSelectiveProjectSteps(
        project: string,
        featureFiles: string[] = [],
        stepPaths?: string
    ): Promise<void> {
        if (!project) return;

        const selectiveEnabled = this.config.getBoolean('SELECTIVE_STEP_LOADING', true);

        // If selective loading disabled or no feature files provided, fallback to load all
        if (!selectiveEnabled || featureFiles.length === 0) {
            return this.loadProjectSteps(project, stepPaths);
        }

        const paths = stepPaths || this.config.get(
            'STEP_DEFINITIONS_PATH',
            'test/common/steps;test/{project}/steps;test/{project}/step-definitions;src/steps'
        );

        const expandedPaths = paths
            .split(';')
            .map(p => p.trim().replace('{project}', project))
            .map(p => path.resolve(process.cwd(), p));

        // Step 1: Build map of all available step files and their directories
        const availableStepFiles = new Map<string, string>(); // basename -> fullPath
        const dirStepFiles = new Map<string, string[]>(); // directory -> [files]

        for (const stepDir of expandedPaths) {
            if (fs.existsSync(stepDir)) {
                this.discoverStepFiles(stepDir, availableStepFiles, dirStepFiles);
            }
        }

        if (availableStepFiles.size === 0) {
            CSReporter.warn(`No step files discovered in paths: ${expandedPaths.join(', ')}`);
            return;
        }

        // Step 2: Extract step texts from feature files
        const requiredStepPatterns = this.extractStepsFromFeatures(featureFiles);

        if (requiredStepPatterns.size === 0) {
            CSReporter.debug(`[SelectiveLoading] No steps found in feature files`);
            return;
        }

        // Step 3: Determine which step files to load using heuristics
        const filesToLoad = this.matchStepFilesToPatterns(
            requiredStepPatterns,
            availableStepFiles,
            dirStepFiles,
            featureFiles
        );

        // Step 4: Load only required step files
        const startTime = Date.now();
        let filesLoaded = 0;

        for (const file of filesToLoad) {
            try {
                require(file);
                CSReporter.debug(`[SelectiveLoading] Loaded: ${path.basename(file)}`);
                filesLoaded++;
            } catch (e: any) {
                CSReporter.warn(`Failed to load step file ${file}: ${e.message}`);
            }
        }

        const duration = Date.now() - startTime;
        const workerId = process.env.WORKER_ID ? `Worker ${process.env.WORKER_ID}` : 'Main';
        CSReporter.info(`[${workerId}] Selective loading: ${filesLoaded}/${availableStepFiles.size} step files (${duration}ms)`);
    }

    /**
     * Load steps for a specific project (fallback to old behavior)
     * This method provides backward compatibility
     *
     * @param project - Project name
     * @param stepPaths - Custom step paths (optional)
     */
    public async loadProjectSteps(project: string, stepPaths?: string): Promise<void> {
        if (!project) return;

        const paths = stepPaths || this.config.get(
            'STEP_DEFINITIONS_PATH',
            'test/common/steps;test/{project}/steps;test/{project}/step-definitions;src/steps'
        );

        // Parse and expand paths
        const expandedPaths = paths
            .split(';')
            .map(p => p.trim().replace('{project}', project))
            .map(p => path.resolve(process.cwd(), p));

        let filesLoaded = false;
        for (const stepDir of expandedPaths) {
            if (fs.existsSync(stepDir)) {
                filesLoaded = this.loadStepFilesRecursively(stepDir) || filesLoaded;
            }
        }

        if (!filesLoaded) {
            CSReporter.warn(`No step definitions found for project: ${project} in paths: ${expandedPaths.join(', ')}`);
        }
    }

    /**
     * Discover all step files in a directory recursively
     */
    private discoverStepFiles(
        dir: string,
        fileMap: Map<string, string>,
        dirMap: Map<string, string[]>
    ): void {
        if (!fs.existsSync(dir)) return;

        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                this.discoverStepFiles(fullPath, fileMap, dirMap);
            } else if (entry.isFile() && this.isStepFile(entry.name)) {
                fileMap.set(entry.name.toLowerCase(), fullPath);

                if (!dirMap.has(dir)) {
                    dirMap.set(dir, []);
                }
                dirMap.get(dir)!.push(fullPath);
            }
        }
    }

    /**
     * Extract step patterns from feature files
     */
    private extractStepsFromFeatures(featureFiles: string[]): Set<string> {
        const steps = new Set<string>();

        for (const featureFile of featureFiles) {
            try {
                const content = fs.readFileSync(featureFile, 'utf-8');

                // Simple regex to extract Gherkin steps
                const stepRegex = /^\s*(Given|When|Then|And|But)\s+(.+)$/gm;
                let match;

                while ((match = stepRegex.exec(content)) !== null) {
                    const stepText = match[2].trim();
                    // Remove data table markers and doc strings
                    if (!stepText.startsWith('"""') && !stepText.startsWith('|')) {
                        steps.add(stepText.toLowerCase());
                    }
                }
            } catch (e: any) {
                CSReporter.warn(`Failed to parse feature file ${featureFile}: ${e.message}`);
            }
        }

        return steps;
    }

    /**
     * Match step files to required step patterns using heuristics
     */
    private matchStepFilesToPatterns(
        requiredPatterns: Set<string>,
        availableFiles: Map<string, string>,
        dirFiles: Map<string, string[]>,
        featureFiles: string[]
    ): Set<string> {
        const filesToLoad = new Set<string>();

        // Strategy 1: Keyword matching
        // Extract keywords from step patterns and match to file names
        const keywords = new Set<string>();

        for (const pattern of requiredPatterns) {
            // Extract meaningful words (ignore common words)
            const words = pattern
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length > 3 && !['given', 'when', 'then', 'with', 'that', 'should', 'have'].includes(w));

            words.forEach(w => keywords.add(w));
        }

        // Match keywords to file names
        for (const [fileName, filePath] of availableFiles) {
            const fileBaseName = fileName.toLowerCase().replace(/\.steps\.(ts|js)$/, '').replace(/steps\.(ts|js)$/, '');

            for (const keyword of keywords) {
                if (fileBaseName.includes(keyword) || keyword.includes(fileBaseName)) {
                    filesToLoad.add(filePath);
                    CSReporter.debug(`[SelectiveLoading] Matched "${fileName}" via keyword "${keyword}"`);
                    break;
                }
            }
        }

        // Strategy 2: Convention-based matching
        // If feature is in "features/login/", load steps from "steps/login/"
        for (const featureFile of featureFiles) {
            const featureDir = path.dirname(featureFile);
            const featureDirName = path.basename(featureDir);

            // Try to find corresponding step directory
            for (const [dir, files] of dirFiles) {
                if (dir.toLowerCase().includes(featureDirName.toLowerCase())) {
                    files.forEach(f => filesToLoad.add(f));
                    CSReporter.debug(`[SelectiveLoading] Matched directory "${dir}" for feature "${featureDirName}"`);
                }
            }
        }

        // Strategy 3: Always load common/shared steps
        for (const [fileName, filePath] of availableFiles) {
            if (fileName.includes('common') || fileName.includes('shared') || fileName.includes('base')) {
                filesToLoad.add(filePath);
            }
        }

        // Fallback: If no files matched, load all (safety)
        if (filesToLoad.size === 0) {
            CSReporter.warn(`[SelectiveLoading] No step files matched, loading all as fallback`);
            availableFiles.forEach((path) => filesToLoad.add(path));
        }

        return filesToLoad;
    }

    /**
     * Recursively load step definition files from a directory
     * (Backward compatibility method)
     */
    private loadStepFilesRecursively(dir: string): boolean {
        let filesLoaded = false;

        if (!fs.existsSync(dir)) {
            return false;
        }

        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                // Recursively load from subdirectories
                filesLoaded = this.loadStepFilesRecursively(fullPath) || filesLoaded;
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
                    } else {
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
