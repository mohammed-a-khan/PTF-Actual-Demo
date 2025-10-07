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

export type StepGroup = 'common' | 'api' | 'database' | 'soap' | 'browser';

export class CSStepLoader {
    private static instance: CSStepLoader;
    private static workerInstances: Map<number, CSStepLoader> = new Map();
    private loadedGroups: Set<StepGroup> = new Set();
    private config: CSConfigurationManager;

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
     */
    public async loadRequiredSteps(requirements: ModuleRequirements): Promise<void> {
        // Check if selective loading is enabled
        const strategy = this.config.get('STEP_LOADING_STRATEGY', 'all');
        if (strategy !== 'selective') {
            // Feature disabled - skip selective loading
            return;
        }

        const startTime = Date.now();
        let groupsLoaded: StepGroup[] = [];

        // Always load common steps (contains browser/UI steps)
        if (!this.loadedGroups.has('common')) {
            await this.loadStepGroup('common');
            groupsLoaded.push('common');
        }

        // Load API steps if required
        if (requirements.api && !this.loadedGroups.has('api')) {
            await this.loadStepGroup('api');
            groupsLoaded.push('api');
        }

        // Load Database steps if required
        if (requirements.database && !this.loadedGroups.has('database')) {
            await this.loadStepGroup('database');
            groupsLoaded.push('database');
        }

        // Load SOAP steps if required
        if (requirements.soap && !this.loadedGroups.has('soap')) {
            await this.loadStepGroup('soap');
            groupsLoaded.push('soap');
        }

        // Log loading results if enabled
        if (this.config.getBoolean('MODULE_DETECTION_LOGGING', false) && groupsLoaded.length > 0) {
            const duration = Date.now() - startTime;
            const workerId = process.env.WORKER_ID ? `Worker ${process.env.WORKER_ID}` : 'Main';
            CSReporter.debug(`[${workerId}] Loaded step groups: ${groupsLoaded.join(', ')} (${duration}ms)`);
        }
    }

    /**
     * Load all step definitions for a specific group
     */
    private async loadStepGroup(groupName: StepGroup): Promise<void> {
        const files = this.STEP_GROUPS[groupName] || [];

        for (const file of files) {
            try {
                const fullPath = this.resolvePath(file);

                // Handle TypeScript vs JavaScript
                let fileToLoad = fullPath;
                if (fullPath.endsWith('.ts') && fullPath.includes('/src/')) {
                    // Convert src path to dist path for TypeScript files
                    const distPath = fullPath.replace('/src/', '/dist/').replace('.ts', '.js');
                    if (fs.existsSync(distPath)) {
                        fileToLoad = distPath;
                    }
                }

                if (fs.existsSync(fileToLoad)) {
                    require(fileToLoad);
                    CSReporter.debug(`Loaded step file: ${path.basename(fileToLoad)}`);
                } else {
                    CSReporter.warn(`Step file not found: ${fileToLoad}`);
                }
            } catch (error: any) {
                CSReporter.error(`Failed to load step file ${file}: ${error.message}`);
            }
        }

        this.loadedGroups.add(groupName);
    }

    /**
     * Resolve step file path relative to project root
     */
    private resolvePath(relativePath: string): string {
        return path.resolve(process.cwd(), relativePath);
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
