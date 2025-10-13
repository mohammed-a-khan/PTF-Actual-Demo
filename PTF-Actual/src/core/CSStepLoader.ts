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
import { ParsedFeature } from '../bdd/CSBDDEngine';

export type StepGroup = 'common' | 'api' | 'database' | 'soap' | 'browser';

export class CSStepLoader {
    private static instance: CSStepLoader;
    private static workerInstances: Map<number, CSStepLoader> = new Map();
    private loadedGroups: Set<StepGroup> = new Set();
    private config: CSConfigurationManager;
    private frameworkRoot: string;

    /**
     * Step definition file groups
     * Maps module types to their step definition files
     */
    private readonly STEP_GROUPS: Record<StepGroup, string[]> = {
        common: [
            'src/steps/common/CSCommonSteps.ts'
        ],
        api: [
            'src/steps/api/CSAPIRequestSteps.ts',
            'src/steps/api/CSAPIRequestExecutionSteps.ts',
            'src/steps/api/CSAPIResponseValidationSteps.ts',
            'src/steps/api/CSAPIValidationSteps.ts',
            'src/steps/api/CSAPIRequestBodySteps.ts',
            'src/steps/api/CSAPIRequestHeaderSteps.ts',
            'src/steps/api/CSAPIRequestConfigSteps.ts',
            'src/steps/api/CSAPIAuthenticationSteps.ts',
            'src/steps/api/CSAPIUtilitySteps.ts',
            'src/steps/api/CSAPIChainingSteps.ts',
            'src/steps/api/CSAPIGenericSteps.ts'
        ],
        database: [
            'src/steps/database/CSDatabaseAPISteps.ts',
            'src/steps/database/QueryExecutionSteps.ts',
            'src/steps/database/StoredProcedureSteps.ts',
            'src/steps/database/DatabaseGenericSteps.ts',
            'src/steps/database/ConnectionSteps.ts',
            'src/steps/database/TransactionSteps.ts',
            'src/steps/database/DataValidationSteps.ts',
            'src/steps/database/DatabaseUtilitySteps.ts'
        ],
        soap: [
            'src/steps/soap/CSSoapSteps.ts'
        ],
        browser: [
            // Browser/UI steps are included in common steps
            // This group exists for future expansion
        ]
    };

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
            const thisFileDir = __dirname; // e.g., /path/to/node_modules/cs-playwright-test-framework/dist/core

            // Check if we're in dist/core (compiled framework)
            if (thisFileDir.includes('dist/core') || thisFileDir.includes('dist\\core')) {
                // Go up two levels: dist/core -> dist -> framework-root
                const frameworkRoot = path.resolve(thisFileDir, '../..');

                // Verify this is the framework by checking package.json
                const packageJsonPath = path.join(frameworkRoot, 'package.json');
                if (fs.existsSync(packageJsonPath)) {
                    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
                    if (pkg.name === 'cs-playwright-test-framework') {
                        CSReporter.debug(`Framework root detected: ${frameworkRoot}`);
                        return frameworkRoot;
                    }
                }
            }

            // Fallback: Try to resolve from node_modules
            try {
                const frameworkPackagePath = require.resolve('cs-playwright-test-framework/package.json');
                const frameworkRoot = path.dirname(frameworkPackagePath);
                CSReporter.debug(`Framework root resolved from node_modules: ${frameworkRoot}`);
                return frameworkRoot;
            } catch (e) {
                // Not in node_modules, probably development mode
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
        const shouldLoadFrameworkSteps = stepPaths.includes('node_modules/cs-playwright-test-framework') ||
                                         stepPaths.includes('cs-playwright-test-framework/dist/steps');

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

        // Extract step patterns from features for file-level filtering
        const stepPatterns = features ? this.extractStepPatterns(features) : undefined;
        const filesLoaded: string[] = [];

        if (useSelectiveLoading) {
            // SELECTIVE LOADING: Only load required step groups
            // Always load common steps (contains browser/UI steps)
            if (!this.loadedGroups.has('common')) {
                const loaded = await this.loadStepGroup('common', stepPatterns);
                filesLoaded.push(...loaded);
                groupsLoaded.push('common');
            }

            // Load API steps if required
            if (requirements.api && !this.loadedGroups.has('api')) {
                const loaded = await this.loadStepGroup('api', stepPatterns);
                filesLoaded.push(...loaded);
                groupsLoaded.push('api');
            }

            // Load Database steps if required
            if (requirements.database && !this.loadedGroups.has('database')) {
                const loaded = await this.loadStepGroup('database', stepPatterns);
                filesLoaded.push(...loaded);
                groupsLoaded.push('database');
            }

            // Load SOAP steps if required
            if (requirements.soap && !this.loadedGroups.has('soap')) {
                const loaded = await this.loadStepGroup('soap', stepPatterns);
                filesLoaded.push(...loaded);
                groupsLoaded.push('soap');
            }
        } else {
            // ALL STRATEGY: Load all framework step groups
            const allGroups: StepGroup[] = ['common', 'api', 'database', 'soap'];
            for (const group of allGroups) {
                if (!this.loadedGroups.has(group)) {
                    const loaded = await this.loadStepGroup(group, stepPatterns);
                    filesLoaded.push(...loaded);
                    groupsLoaded.push(group);
                }
            }
        }

        // Log loading results if enabled
        if (this.config.getBoolean('MODULE_DETECTION_LOGGING', false) && groupsLoaded.length > 0) {
            const duration = Date.now() - startTime;
            const workerId = process.env.WORKER_ID ? `Worker ${process.env.WORKER_ID}` : 'Main';
            const mode = useSelectiveLoading ? 'selective' : 'all';

            if (stepPatterns && filesLoaded.length > 0) {
                CSReporter.debug(`[${workerId}] Loaded framework step groups (${mode}, file-level): ${groupsLoaded.join(', ')} - ${filesLoaded.length} files (${duration}ms)`);
            } else {
                CSReporter.debug(`[${workerId}] Loaded framework step groups (${mode}): ${groupsLoaded.join(', ')} (${duration}ms)`);
            }
        }
    }

    /**
     * Load all step definitions for a specific group
     * @param groupName - The step group to load
     * @param stepPatterns - Optional step patterns for file-level filtering
     * @returns Array of loaded file names
     */
    private async loadStepGroup(groupName: StepGroup, stepPatterns?: Set<string>): Promise<string[]> {
        const files = this.STEP_GROUPS[groupName] || [];
        const loadedFiles: string[] = [];

        for (const file of files) {
            try {
                const fullPath = this.resolvePath(file);
                let pathToCheck = fullPath;

                // Check if file exists, try alternate path for dev mode
                if (!fs.existsSync(fullPath)) {
                    const srcPath = fullPath.replace('/dist/', '/src/').replace('.js', '.ts');
                    if (fs.existsSync(srcPath)) {
                        pathToCheck = srcPath;
                    } else {
                        CSReporter.warn(`Framework step file not found: ${fullPath}`);
                        continue;
                    }
                }

                // If step patterns provided, check if file contains required steps
                if (stepPatterns && stepPatterns.size > 0) {
                    const containsSteps = await this.fileContainsSteps(pathToCheck, stepPatterns);
                    if (!containsSteps) {
                        CSReporter.debug(`Skipping framework step file (no required steps): ${path.basename(pathToCheck)}`);
                        continue;
                    }
                }

                // Load the file
                require(pathToCheck);
                loadedFiles.push(path.basename(pathToCheck));
                CSReporter.debug(`Loaded framework step file: ${path.basename(pathToCheck)}`);

            } catch (error: any) {
                CSReporter.error(`Failed to load framework step file ${file}: ${error.message}`);
            }
        }

        this.loadedGroups.add(groupName);
        return loadedFiles;
    }

    /**
     * Resolve step file path relative to framework root
     * Automatically converts src/ paths to dist/ paths when framework is compiled
     */
    private resolvePath(relativePath: string): string {
        // Convert src/ to dist/ for framework step files
        let adjustedPath = relativePath;
        if (relativePath.startsWith('src/')) {
            adjustedPath = relativePath.replace('src/', 'dist/');
        }

        // Replace .ts extension with .js for compiled files
        if (adjustedPath.endsWith('.ts')) {
            adjustedPath = adjustedPath.replace('.ts', '.js');
        }

        const resolvedPath = path.resolve(this.frameworkRoot, adjustedPath);
        return resolvedPath;
    }

    /**
     * Extract all unique step patterns from parsed features
     * @param features - Parsed features
     * @returns Set of step text patterns
     */
    private extractStepPatterns(features: ParsedFeature[]): Set<string> {
        const stepPatterns = new Set<string>();

        for (const feature of features) {
            // Add background steps
            if ((feature as any).background) {
                (feature as any).background.steps.forEach((step: any) => {
                    stepPatterns.add(step.text);
                });
            }

            // Add scenario steps
            for (const scenario of feature.scenarios) {
                scenario.steps.forEach(step => {
                    stepPatterns.add(step.text);
                });
            }
        }

        return stepPatterns;
    }

    /**
     * Check if a file contains any of the required step patterns
     * @param filePath - Path to the step definition file
     * @param stepPatterns - Set of step text patterns to match
     * @returns True if file contains any required steps
     */
    private async fileContainsSteps(filePath: string, stepPatterns: Set<string>): Promise<boolean> {
        try {
            const content = fs.readFileSync(filePath, 'utf8');

            // Check if file contains step definition decorators
            // Source (.ts): @CSBDDStepDef('pattern')
            // Compiled (.js): CSBDDStepDef)('pattern')
            if (!content.includes('@CSBDDStepDef') &&
                !content.includes('CSBDDStepDef(') &&
                !content.includes('CSBDDStepDef)')) {
                return false;
            }

            // Check if file contains any of the step patterns
            for (const pattern of stepPatterns) {
                try {
                    // Remove quoted values and parameters to get base text
                    const baseText = pattern
                        .replace(/"[^"]*"/g, '')  // Remove quoted strings
                        .replace(/\d+/g, '')       // Remove numbers
                        .replace(/^\s*(Given|When|Then|And|But)\s+/i, '') // Remove Gherkin keywords
                        .trim();

                    // Split into significant words (excluding empty strings)
                    const stepWords = baseText.split(/\s+/).filter(word => word.length > 2);

                    if (stepWords.length > 0) {
                        // Create pattern that matches the decorator format with {string} or {int} parameters
                        const searchPattern = stepWords.join('.*');
                        const regex = new RegExp(`@CSBDDStepDef\\(['\"\`].*${searchPattern}.*['\"\`]\\)`, 'i');
                        if (regex.test(content)) {
                            return true;
                        }

                        // Also check for the exact pattern without the Gherkin keyword
                        const withoutKeyword = pattern.replace(/^\s*(Given|When|Then|And|But)\s+/i, '');

                        // Convert the actual step text to a pattern that matches parameter placeholders
                        const stepPattern = withoutKeyword
                            .replace(/"[^"]*"/g, '{string}')           // Replace quoted strings with {string}
                            .replace(/\b\d+\.\d+\b/g, '{float}')       // Replace floats with {float}
                            .replace(/\b\d+\b/g, '{int}')              // Replace integers with {int}
                            .replace(/\b(true|false)\b/gi, '{boolean}') // Replace booleans with {boolean}
                            .replace(/\{[^}]+\}/g, (match) => match);   // Keep existing placeholders

                        // Check if this pattern exists in the file
                        if (content.includes(stepPattern)) {
                            return true;
                        }

                        // Also try a more generic match for any {word} pattern
                        const genericPattern = withoutKeyword
                            .replace(/"[^"]*"/g, '{word}')
                            .replace(/\b\d+\.\d+\b/g, '{word}')
                            .replace(/\b\d+\b/g, '{word}')
                            .replace(/\b(true|false)\b/gi, '{word}');

                        if (content.includes(genericPattern)) {
                            return true;
                        }
                    }
                } catch (error) {
                    // Continue if regex fails
                    continue;
                }
            }

            return false;
        } catch (error: any) {
            CSReporter.warn(`Failed to read framework step file ${filePath}: ${error.message}`);
            return false;
        }
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
