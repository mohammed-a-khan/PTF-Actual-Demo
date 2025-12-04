/**
 * CS Suite Config Loader - YAML configuration parser for multi-project execution
 * @module suite/CSSuiteConfigLoader
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
    SuiteConfig,
    SuiteProjectConfig,
    SuiteDefaults,
    SuiteExecutionConfig,
    SuiteReportingConfig,
    SuiteMode,
    SuiteCLIOptions
} from './types/CSSuiteTypes';

/**
 * Default suite configuration values
 */
const DEFAULT_SUITE_CONFIG: Omit<SuiteConfig, 'projects'> = {
    version: '1.0',
    name: 'Test Suite',
    description: 'Multi-project test execution suite',
    defaults: {
        environment: 'SIT',
        headless: true,
        timeout: 300000,
        parallel: 1,
        retry: 0
    },
    execution: {
        mode: 'sequential',
        stopOnFailure: false,
        delayBetweenProjects: 2000
    },
    reporting: {
        consolidated: true,
        autoOpen: true,
        formats: ['html', 'json']
    }
};

/**
 * Suite configuration loader
 */
export class CSSuiteConfigLoader {
    private static instance: CSSuiteConfigLoader;
    private config: SuiteConfig | null = null;
    private configPath: string | null = null;

    private constructor() {}

    /**
     * Get singleton instance
     */
    public static getInstance(): CSSuiteConfigLoader {
        if (!CSSuiteConfigLoader.instance) {
            CSSuiteConfigLoader.instance = new CSSuiteConfigLoader();
        }
        return CSSuiteConfigLoader.instance;
    }

    /**
     * Load suite configuration from YAML file
     * @param configPath Path to YAML config file (optional, defaults to test-suite.yaml)
     * @param cliOptions CLI options to override config values
     */
    public async load(configPath?: string, cliOptions?: Partial<SuiteCLIOptions>): Promise<SuiteConfig> {
        // Determine config file path
        this.configPath = this.resolveConfigPath(configPath);

        // Load and parse YAML
        const rawConfig = this.loadYamlFile(this.configPath);

        // Merge with defaults
        const mergedConfig = this.mergeWithDefaults(rawConfig);

        // Apply CLI overrides
        const finalConfig = this.applyCLIOverrides(mergedConfig, cliOptions);

        // Validate configuration
        this.validateConfig(finalConfig);

        // Filter projects by mode
        if (cliOptions?.suiteMode) {
            finalConfig.projects = this.filterProjectsByMode(finalConfig.projects, cliOptions.suiteMode);
        }

        // Filter enabled projects only
        finalConfig.projects = finalConfig.projects.filter(p => p.enabled);

        this.config = finalConfig;
        return finalConfig;
    }

    /**
     * Get loaded configuration
     */
    public getConfig(): SuiteConfig {
        if (!this.config) {
            throw new Error('Suite configuration not loaded. Call load() first.');
        }
        return this.config;
    }

    /**
     * Resolve configuration file path
     */
    private resolveConfigPath(configPath?: string): string {
        if (configPath) {
            const resolved = path.resolve(process.cwd(), configPath);
            if (!fs.existsSync(resolved)) {
                throw new Error(`Suite configuration file not found: ${resolved}`);
            }
            return resolved;
        }

        // Look for default config files in order of preference
        const defaultPaths = [
            'test-suite.yaml',
            'test-suite.yml',
            'suite.yaml',
            'suite.yml',
            'config/test-suite.yaml',
            'config/suite.yaml'
        ];

        for (const defaultPath of defaultPaths) {
            const resolved = path.resolve(process.cwd(), defaultPath);
            if (fs.existsSync(resolved)) {
                return resolved;
            }
        }

        throw new Error(
            'Suite configuration file not found. Create test-suite.yaml or specify path with --suite-config'
        );
    }

    /**
     * Load and parse YAML file
     */
    private loadYamlFile(filePath: string): any {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const parsed = yaml.load(content);

            if (!parsed || typeof parsed !== 'object') {
                throw new Error('Invalid YAML content');
            }

            return parsed;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                throw new Error(`Suite configuration file not found: ${filePath}`);
            }
            throw new Error(`Failed to parse suite configuration: ${error.message}`);
        }
    }

    /**
     * Merge loaded config with defaults
     */
    private mergeWithDefaults(rawConfig: any): SuiteConfig {
        const config: SuiteConfig = {
            version: rawConfig.version || DEFAULT_SUITE_CONFIG.version,
            name: rawConfig.name || DEFAULT_SUITE_CONFIG.name,
            description: rawConfig.description || DEFAULT_SUITE_CONFIG.description,
            defaults: {
                ...DEFAULT_SUITE_CONFIG.defaults,
                ...(rawConfig.defaults || {})
            },
            execution: {
                ...DEFAULT_SUITE_CONFIG.execution,
                ...(rawConfig.execution || {})
            },
            reporting: {
                ...DEFAULT_SUITE_CONFIG.reporting,
                ...(rawConfig.reporting || {})
            },
            projects: this.parseProjects(rawConfig.projects || [])
        };

        return config;
    }

    /**
     * Parse and normalize project configurations
     */
    private parseProjects(projects: any[]): SuiteProjectConfig[] {
        if (!Array.isArray(projects)) {
            throw new Error('Projects must be an array in suite configuration');
        }

        return projects.map((project, index) => {
            if (!project.name) {
                throw new Error(`Project at index ${index} must have a name`);
            }
            if (!project.project) {
                throw new Error(`Project "${project.name}" must have a project identifier`);
            }
            if (!project.features) {
                throw new Error(`Project "${project.name}" must have features defined`);
            }

            return {
                name: project.name,
                type: project.type || 'ui',
                project: project.project,
                features: project.features,
                tags: project.tags,
                enabled: project.enabled !== false, // Default to true
                environment: project.environment,
                timeout: project.timeout,
                browser: project.browser,
                headless: project.headless,
                parallel: project.parallel,
                retry: project.retry
            };
        });
    }

    /**
     * Apply CLI option overrides
     */
    private applyCLIOverrides(config: SuiteConfig, cliOptions?: Partial<SuiteCLIOptions>): SuiteConfig {
        if (!cliOptions) {
            return config;
        }

        // Apply stop on failure override
        if (cliOptions.suiteStopOnFailure !== undefined) {
            config.execution.stopOnFailure = cliOptions.suiteStopOnFailure;
        }

        // Apply global overrides to all projects
        config.projects = config.projects.map(project => {
            const updated = { ...project };

            // Environment override
            if (cliOptions.environment && !project.environment) {
                updated.environment = cliOptions.environment;
            }

            // Tags override (append to existing)
            if (cliOptions.tags) {
                if (project.tags) {
                    updated.tags = `${project.tags} and ${cliOptions.tags}`;
                } else {
                    updated.tags = cliOptions.tags;
                }
            }

            // Headless override
            if (cliOptions.headless !== undefined && project.headless === undefined) {
                updated.headless = cliOptions.headless;
            }

            // Parallel override
            if (cliOptions.parallel !== undefined || cliOptions.workers !== undefined) {
                const parallelValue = cliOptions.workers ||
                    (typeof cliOptions.parallel === 'number' ? cliOptions.parallel :
                     cliOptions.parallel === true ? 3 : undefined);

                if (parallelValue !== undefined && project.parallel === undefined) {
                    updated.parallel = parallelValue;
                }
            }

            return updated;
        });

        return config;
    }

    /**
     * Filter projects by execution mode
     */
    private filterProjectsByMode(projects: SuiteProjectConfig[], mode: SuiteMode): SuiteProjectConfig[] {
        switch (mode) {
            case 'api-only':
                return projects.filter(p => p.type === 'api');
            case 'ui-only':
                return projects.filter(p => p.type === 'ui');
            case 'all':
            default:
                return projects;
        }
    }

    /**
     * Validate configuration
     */
    private validateConfig(config: SuiteConfig): void {
        // Validate version
        if (!config.version) {
            throw new Error('Suite configuration must have a version');
        }

        // Validate projects
        if (!config.projects || config.projects.length === 0) {
            throw new Error('Suite configuration must have at least one project');
        }

        // Validate each project
        const projectNames = new Set<string>();
        for (const project of config.projects) {
            // Check for duplicate names
            if (projectNames.has(project.name)) {
                throw new Error(`Duplicate project name: ${project.name}`);
            }
            projectNames.add(project.name);

            // Validate project type
            if (!['api', 'ui', 'hybrid'].includes(project.type)) {
                throw new Error(`Invalid project type "${project.type}" for project "${project.name}". Must be: api, ui, or hybrid`);
            }

            // Validate features
            if (!project.features || (Array.isArray(project.features) && project.features.length === 0)) {
                throw new Error(`Project "${project.name}" must have at least one feature file`);
            }
        }

        // Validate execution config
        if (config.execution.delayBetweenProjects < 0) {
            throw new Error('delayBetweenProjects must be non-negative');
        }

        // Validate defaults
        if (config.defaults.timeout < 0) {
            throw new Error('Default timeout must be non-negative');
        }
    }

    /**
     * Create a sample configuration file
     */
    public static createSampleConfig(outputPath: string = 'test-suite.yaml'): void {
        const sampleConfig = `# Test Suite Configuration
# Multi-project test execution configuration file
# Version: 1.0

version: "1.0"
name: "Enterprise Test Suite"
description: "Sequential execution of all application tests"

# Default settings applied to all projects unless overridden
defaults:
  environment: SIT
  headless: true
  timeout: 300000
  parallel: 1
  retry: 0

# Execution settings
execution:
  mode: sequential          # Projects run one after another
  stopOnFailure: false      # Continue even if a project fails
  delayBetweenProjects: 2000  # 2 second delay between projects

# Reporting settings
reporting:
  consolidated: true        # Generate consolidated report
  autoOpen: true           # Auto-open report in browser
  formats:
    - html
    - json

# Projects to execute
projects:
  # API Test Project Example
  - name: API-Service
    type: api
    project: api-service
    features: test/api-service/features/api-tests.feature
    enabled: true

  # UI Test Project Example
  - name: Web-App
    type: ui
    project: web-app
    features: test/web-app/features/login-tests.feature
    tags: "@smoke"
    enabled: true
    headless: true

  # Another UI Project with multiple features
  - name: Portal
    type: ui
    project: portal
    features:
      - test/portal/features/dashboard.feature
      - test/portal/features/reports.feature
    enabled: true
    parallel: 3            # Override parallel workers for this project

  # Disabled project (won't run)
  - name: Legacy-App
    type: ui
    project: legacy
    features: test/legacy/features/*.feature
    enabled: false
`;

        const resolvedPath = path.resolve(process.cwd(), outputPath);
        fs.writeFileSync(resolvedPath, sampleConfig, 'utf8');
        console.log(`Sample suite configuration created: ${resolvedPath}`);
    }

    /**
     * Get configuration file path
     */
    public getConfigPath(): string | null {
        return this.configPath;
    }

    /**
     * Reset loader (for testing)
     */
    public reset(): void {
        this.config = null;
        this.configPath = null;
    }
}

export default CSSuiteConfigLoader;
