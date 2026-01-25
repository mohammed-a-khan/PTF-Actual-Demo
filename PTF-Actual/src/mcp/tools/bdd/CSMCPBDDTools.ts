/**
 * CS Playwright MCP BDD Tools
 * BDD/Cucumber feature and step management tools
 * Real implementation using CSBDDRunner and CSBDDEngine
 *
 * @module CSMCPBDDTools
 */

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import {
    MCPToolDefinition,
    MCPToolResult,
    MCPToolContext,
    MCPTextContent,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// Lazy load framework components
let CSBDDRunner: any = null;
let CSBDDEngine: any = null;
let CSScenarioContext: any = null;
let CSReporter: any = null;
let CSConfigurationManager: any = null;
let CSValueResolver: any = null;

function ensureFrameworkLoaded(): void {
    if (!CSBDDRunner) {
        CSBDDRunner = require('../../../bdd/CSBDDRunner').CSBDDRunner;
    }
    if (!CSBDDEngine) {
        CSBDDEngine = require('../../../bdd/CSBDDEngine').CSBDDEngine;
    }
    if (!CSScenarioContext) {
        CSScenarioContext = require('../../../bdd/CSScenarioContext').CSScenarioContext;
    }
    if (!CSReporter) {
        CSReporter = require('../../../reporter/CSReporter').CSReporter;
    }
    if (!CSConfigurationManager) {
        CSConfigurationManager = require('../../../core/CSConfigurationManager').CSConfigurationManager;
    }
    if (!CSValueResolver) {
        try {
            CSValueResolver = require('../../../utils/CSValueResolver').CSValueResolver;
        } catch {
            // Optional module
        }
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

function createTextResult(text: string): MCPToolResult {
    return {
        content: [{ type: 'text', text } as MCPTextContent],
    };
}

function createJsonResult(data: unknown): MCPToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) } as MCPTextContent],
        structuredContent: data as Record<string, unknown>,
    };
}

function createErrorResult(message: string): MCPToolResult {
    return {
        content: [{ type: 'text', text: `Error: ${message}` } as MCPTextContent],
        isError: true,
    };
}

/**
 * Get feature files directory from config
 */
function getFeaturesDir(): string {
    ensureFrameworkLoaded();
    const config = CSConfigurationManager.getInstance();
    const project = config.get('PROJECT', 'common');
    return path.join(process.cwd(), 'test', project, 'features');
}

/**
 * Get step definitions directory from config
 */
function getStepsDir(): string {
    ensureFrameworkLoaded();
    const config = CSConfigurationManager.getInstance();
    const project = config.get('PROJECT', 'common');
    return path.join(process.cwd(), 'test', project, 'steps');
}

// ============================================================================
// Feature File Tools
// ============================================================================

const listFeaturesTool = defineTool()
    .name('bdd_list_features')
    .description('List all feature files in the project')
    .category('bdd')
    .stringParam('pattern', 'Glob pattern to filter features', { default: '**/*.feature' })
    .stringParam('directory', 'Directory to search in (defaults to project features directory)')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const featuresDir = (params.directory as string) || getFeaturesDir();
        const pattern = (params.pattern as string) || '**/*.feature';

        context.log('info', `Listing features from ${featuresDir}`);
        CSReporter.info(`[MCP] Listing features from: ${featuresDir}`);

        try {
            if (!fs.existsSync(featuresDir)) {
                return createJsonResult({
                    directory: featuresDir,
                    features: [],
                    count: 0,
                    message: 'Features directory not found',
                });
            }

            const fullPattern = path.join(featuresDir, pattern);
            const files = await glob(fullPattern);

            const features = files.map((file: string) => {
                const relativePath = path.relative(featuresDir, file);
                const content = fs.readFileSync(file, 'utf-8');
                const featureName = content.match(/Feature:\s*(.+)/)?.[1] || 'Unknown';
                const tags = content.match(/@\w+/g) || [];
                const scenarioCount = (content.match(/Scenario:|Scenario Outline:/g) || []).length;

                return {
                    path: relativePath,
                    fullPath: file,
                    name: featureName.trim(),
                    tags: [...new Set(tags)],
                    scenarioCount,
                };
            });

            CSReporter.pass(`[MCP] Found ${features.length} feature files`);

            return createJsonResult({
                directory: featuresDir,
                features,
                count: features.length,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Failed to list features: ${error.message}`);
            return createErrorResult(`Failed to list features: ${error.message}`);
        }
    })
    .readOnly()
    .build();

const parseFeatureTool = defineTool()
    .name('bdd_parse_feature')
    .description('Parse a feature file and return its structure using CSBDDEngine')
    .category('bdd')
    .stringParam('path', 'Path to the feature file', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const featurePath = params.path as string;

        context.log('info', `Parsing feature: ${featurePath}`);
        CSReporter.info(`[MCP] Parsing feature: ${featurePath}`);

        try {
            // Resolve path
            let fullPath = featurePath;
            if (!path.isAbsolute(featurePath)) {
                fullPath = path.join(getFeaturesDir(), featurePath);
            }

            if (!fs.existsSync(fullPath)) {
                return createErrorResult(`Feature file not found: ${fullPath}`);
            }

            // Use CSBDDEngine to parse the feature
            const bddEngine = CSBDDEngine.getInstance();
            const parsed = bddEngine.parseFeature(fullPath);

            CSReporter.pass(`[MCP] Feature parsed: ${parsed.name}`);

            return createJsonResult({
                name: parsed.name,
                description: parsed.description,
                tags: parsed.tags,
                scenarios: parsed.scenarios.map((s: any) => ({
                    name: s.name,
                    tags: s.tags,
                    steps: s.steps.map((step: any) => ({
                        keyword: step.keyword,
                        text: step.text,
                        argument: step.argument,
                    })),
                    examples: s.examples,
                })),
                background: parsed.background,
                path: fullPath,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Failed to parse feature: ${error.message}`);
            return createErrorResult(`Failed to parse feature: ${error.message}`);
        }
    })
    .readOnly()
    .build();

const runFeatureTool = defineTool()
    .name('bdd_run_feature')
    .description('Run a feature file using CSBDDRunner')
    .category('bdd')
    .stringParam('path', 'Path to the feature file', { required: true })
    .stringParam('tags', 'Tags to filter scenarios (e.g., "@smoke and not @slow")')
    .booleanParam('dryRun', 'Parse and validate without executing', { default: false })
    .numberParam('retry', 'Number of retries for failed scenarios')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const featurePath = params.path as string;

        context.log('info', `Running feature: ${featurePath}`);
        CSReporter.info(`[MCP] Running feature: ${featurePath}`);

        try {
            // Resolve path
            let fullPath = featurePath;
            if (!path.isAbsolute(featurePath)) {
                fullPath = path.join(getFeaturesDir(), featurePath);
            }

            if (!fs.existsSync(fullPath)) {
                return createErrorResult(`Feature file not found: ${fullPath}`);
            }

            const runner = CSBDDRunner.getInstance();

            // Run with options
            const runOptions: any = {
                features: fullPath,
                tags: params.tags as string,
                dryRun: params.dryRun === true,
                retry: params.retry as number,
            };

            await runner.run(runOptions);

            CSReporter.pass(`[MCP] Feature execution completed: ${featurePath}`);

            return createJsonResult({
                status: 'completed',
                feature: featurePath,
                dryRun: params.dryRun === true,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Feature execution failed: ${error.message}`);
            return createErrorResult(`Feature execution failed: ${error.message}`);
        }
    })
    .build();

const runScenarioTool = defineTool()
    .name('bdd_run_scenario')
    .description('Run a specific scenario from a feature file')
    .category('bdd')
    .stringParam('feature', 'Path to the feature file', { required: true })
    .stringParam('scenario', 'Scenario name to run', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const featurePath = params.feature as string;
        const scenarioName = params.scenario as string;

        context.log('info', `Running scenario: ${scenarioName} from ${featurePath}`);
        CSReporter.info(`[MCP] Running scenario: ${scenarioName}`);

        try {
            // Resolve path
            let fullPath = featurePath;
            if (!path.isAbsolute(featurePath)) {
                fullPath = path.join(getFeaturesDir(), featurePath);
            }

            if (!fs.existsSync(fullPath)) {
                return createErrorResult(`Feature file not found: ${fullPath}`);
            }

            const runner = CSBDDRunner.getInstance();

            // Run with scenario filter
            await runner.run({
                features: fullPath,
                scenario: scenarioName,
            });

            CSReporter.pass(`[MCP] Scenario completed: ${scenarioName}`);

            return createJsonResult({
                status: 'completed',
                feature: featurePath,
                scenario: scenarioName,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Scenario execution failed: ${error.message}`);
            return createErrorResult(`Scenario execution failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Step Definition Tools
// ============================================================================

const listStepDefinitionsTool = defineTool()
    .name('bdd_list_step_definitions')
    .description('List step definition files in the project')
    .category('bdd')
    .stringParam('pattern', 'Glob pattern to filter files', { default: '**/*.steps.ts' })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const stepsDir = getStepsDir();
        const pattern = (params.pattern as string) || '**/*.steps.ts';

        context.log('info', `Listing step definitions from ${stepsDir}`);
        CSReporter.info(`[MCP] Listing step definitions from: ${stepsDir}`);

        try {
            if (!fs.existsSync(stepsDir)) {
                return createJsonResult({
                    directory: stepsDir,
                    files: [],
                    count: 0,
                    message: 'Steps directory not found',
                });
            }

            const fullPattern = path.join(stepsDir, pattern);
            const files = await glob(fullPattern);

            const stepFiles = files.map((file: string) => {
                const relativePath = path.relative(stepsDir, file);
                const content = fs.readFileSync(file, 'utf-8');

                // Count step definitions
                const givenCount = (content.match(/@Given|@CSBDDStepDef\(['"]Given/g) || []).length;
                const whenCount = (content.match(/@When|@CSBDDStepDef\(['"]When/g) || []).length;
                const thenCount = (content.match(/@Then|@CSBDDStepDef\(['"]Then/g) || []).length;
                const andCount = (content.match(/@And|@CSBDDStepDef\(['"]And/g) || []).length;

                return {
                    path: relativePath,
                    fullPath: file,
                    stepCount: {
                        given: givenCount,
                        when: whenCount,
                        then: thenCount,
                        and: andCount,
                        total: givenCount + whenCount + thenCount + andCount,
                    },
                };
            });

            const totalSteps = stepFiles.reduce((sum: number, f: any) => sum + f.stepCount.total, 0);

            CSReporter.pass(`[MCP] Found ${stepFiles.length} step files with ${totalSteps} steps`);

            return createJsonResult({
                directory: stepsDir,
                files: stepFiles,
                count: stepFiles.length,
                totalSteps,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Failed to list step definitions: ${error.message}`);
            return createErrorResult(`Failed to list step definitions: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Scenario Context Tools
// ============================================================================

const getScenarioContextTool = defineTool()
    .name('bdd_get_scenario_context')
    .description('Get a value from the scenario context using CSScenarioContext')
    .category('bdd')
    .stringParam('key', 'Context key to retrieve', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const key = params.key as string;

        try {
            const scenarioContext = CSScenarioContext.getInstance();
            const value = scenarioContext.get(key);

            return createJsonResult({
                key,
                value,
                exists: value !== undefined,
            });
        } catch (error: any) {
            return createErrorResult(`Failed to get context: ${error.message}`);
        }
    })
    .readOnly()
    .build();

const setScenarioContextTool = defineTool()
    .name('bdd_set_scenario_context')
    .description('Set a value in the scenario context using CSScenarioContext')
    .category('bdd')
    .stringParam('key', 'Context key to set', { required: true })
    .stringParam('value', 'Value to set', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const key = params.key as string;
        const value = params.value as string;

        context.log('info', `Setting scenario context: ${key}`);
        CSReporter.info(`[MCP] Setting scenario context: ${key}`);

        try {
            const scenarioContext = CSScenarioContext.getInstance();
            scenarioContext.set(key, value);

            CSReporter.pass(`[MCP] Context set: ${key}`);

            return createJsonResult({
                key,
                value,
                set: true,
            });
        } catch (error: any) {
            return createErrorResult(`Failed to set context: ${error.message}`);
        }
    })
    .build();

const clearScenarioContextTool = defineTool()
    .name('bdd_clear_scenario_context')
    .description('Clear the scenario context using CSScenarioContext')
    .category('bdd')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Clearing scenario context');
        CSReporter.info('[MCP] Clearing scenario context');

        try {
            const scenarioContext = CSScenarioContext.getInstance();
            scenarioContext.clear();

            CSReporter.pass('[MCP] Scenario context cleared');

            return createTextResult('Scenario context cleared');
        } catch (error: any) {
            return createErrorResult(`Failed to clear context: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Value Resolution Tools
// ============================================================================

const resolveValueTool = defineTool()
    .name('bdd_resolve_value')
    .description('Resolve a value with variable interpolation using CSValueResolver')
    .category('bdd')
    .stringParam('value', 'Value to resolve (can contain {{var}}, $var, {scenario:var}, {config:KEY}, {env:VAR})', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const value = params.value as string;

        try {
            let resolved = value;

            if (CSValueResolver) {
                const resolver = CSValueResolver.getInstance();
                resolved = resolver.resolve(value);
            } else {
                // Basic interpolation
                const scenarioContext = CSScenarioContext.getInstance();
                const config = CSConfigurationManager.getInstance();

                // Replace {scenario:var}
                resolved = resolved.replace(/\{scenario:(\w+)\}/g, (_: string, key: string) => {
                    return scenarioContext.get(key) ?? `{scenario:${key}}`;
                });

                // Replace {config:KEY}
                resolved = resolved.replace(/\{config:(\w+)\}/g, (_: string, key: string) => {
                    return config.get(key) ?? `{config:${key}}`;
                });

                // Replace {env:VAR}
                resolved = resolved.replace(/\{env:(\w+)\}/g, (_: string, key: string) => {
                    return process.env[key] ?? `{env:${key}}`;
                });
            }

            return createJsonResult({
                original: value,
                resolved,
                interpolated: value !== resolved,
            });
        } catch (error: any) {
            return createErrorResult(`Failed to resolve value: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Data Source Tools
// ============================================================================

const loadDataSourceTool = defineTool()
    .name('bdd_load_data_source')
    .description('Load test data from a data source file (JSON, YAML, CSV, Excel)')
    .category('bdd')
    .stringParam('path', 'Path to the data source file', { required: true })
    .stringParam('filter', 'Filter expression (e.g., "runFlag==Y")')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const dataPath = params.path as string;
        const filter = params.filter as string;

        context.log('info', `Loading data source: ${dataPath}`);
        CSReporter.info(`[MCP] Loading data source: ${dataPath}`);

        try {
            // Resolve path
            let fullPath = dataPath;
            if (!path.isAbsolute(dataPath)) {
                const config = CSConfigurationManager.getInstance();
                const project = config.get('PROJECT', 'common');
                fullPath = path.join(process.cwd(), 'test', project, 'data', dataPath);
            }

            if (!fs.existsSync(fullPath)) {
                return createErrorResult(`Data source not found: ${fullPath}`);
            }

            const ext = path.extname(fullPath).toLowerCase();
            let data: any[] = [];

            if (ext === '.json') {
                const content = fs.readFileSync(fullPath, 'utf-8');
                const parsed = JSON.parse(content);
                data = Array.isArray(parsed) ? parsed : [parsed];
            } else if (ext === '.yaml' || ext === '.yml') {
                const yaml = require('js-yaml');
                const content = fs.readFileSync(fullPath, 'utf-8');
                const parsed = yaml.load(content);
                data = Array.isArray(parsed) ? parsed : [parsed];
            } else if (ext === '.csv') {
                const { parse } = require('csv-parse/sync');
                const content = fs.readFileSync(fullPath, 'utf-8');
                data = parse(content, { columns: true, skip_empty_lines: true });
            } else {
                return createErrorResult(`Unsupported data source format: ${ext}`);
            }

            // Apply filter if specified
            if (filter) {
                const [field, value] = filter.split('==');
                if (field && value) {
                    data = data.filter((item: any) => String(item[field.trim()]) === value.trim());
                }
            }

            CSReporter.pass(`[MCP] Loaded ${data.length} records from ${dataPath}`);

            return createJsonResult({
                path: fullPath,
                format: ext.replace('.', ''),
                records: data,
                count: data.length,
                filter: filter || null,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Failed to load data source: ${error.message}`);
            return createErrorResult(`Failed to load data source: ${error.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Suite Execution Tools
// ============================================================================

const runSuiteTool = defineTool()
    .name('bdd_run_suite')
    .description('Run a test suite (multiple features) using CSBDDRunner')
    .category('bdd')
    .stringParam('features', 'Glob pattern for feature files', { default: '**/*.feature' })
    .stringParam('tags', 'Tags expression to filter scenarios')
    .stringParam('excludeTags', 'Tags to exclude')
    .booleanParam('parallel', 'Run in parallel', { default: false })
    .numberParam('workers', 'Number of parallel workers')
    .numberParam('retry', 'Number of retries for failed scenarios')
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        context.log('info', 'Running BDD test suite');
        CSReporter.info('[MCP] Running BDD test suite');

        try {
            const runner = CSBDDRunner.getInstance();
            const featuresDir = getFeaturesDir();

            // Resolve feature pattern
            const featurePattern = params.features as string || '**/*.feature';
            const fullPattern = path.join(featuresDir, featurePattern);

            await runner.run({
                features: fullPattern,
                tags: params.tags as string,
                excludeTags: params.excludeTags as string,
                parallel: params.parallel === true,
                workers: params.workers as number,
                retry: params.retry as number,
            });

            CSReporter.pass('[MCP] Test suite completed');

            return createJsonResult({
                status: 'completed',
                featuresPattern: fullPattern,
                tags: params.tags || null,
                parallel: params.parallel === true,
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Suite execution failed: ${error.message}`);
            return createErrorResult(`Suite execution failed: ${error.message}`);
        }
    })
    .build();

// ============================================================================
// Validation Tools
// ============================================================================

const validateFeatureTool = defineTool()
    .name('bdd_validate_feature')
    .description('Validate a feature file for syntax and step definition coverage')
    .category('bdd')
    .stringParam('path', 'Path to the feature file', { required: true })
    .handler(async (params, context) => {
        ensureFrameworkLoaded();

        const featurePath = params.path as string;

        context.log('info', `Validating feature: ${featurePath}`);
        CSReporter.info(`[MCP] Validating feature: ${featurePath}`);

        try {
            // Resolve path
            let fullPath = featurePath;
            if (!path.isAbsolute(featurePath)) {
                fullPath = path.join(getFeaturesDir(), featurePath);
            }

            if (!fs.existsSync(fullPath)) {
                return createErrorResult(`Feature file not found: ${fullPath}`);
            }

            // Parse the feature
            const bddEngine = CSBDDEngine.getInstance();
            const parsed = bddEngine.parseFeature(fullPath);

            const issues: string[] = [];
            const warnings: string[] = [];

            // Check for empty scenarios
            for (const scenario of parsed.scenarios) {
                if (!scenario.steps || scenario.steps.length === 0) {
                    issues.push(`Scenario "${scenario.name}" has no steps`);
                }

                // Check for missing Given/When/Then pattern
                const keywords = scenario.steps.map((s: any) => s.keyword.trim());
                if (!keywords.some((k: string) => k === 'Given')) {
                    warnings.push(`Scenario "${scenario.name}" has no Given step`);
                }
                if (!keywords.some((k: string) => k === 'When')) {
                    warnings.push(`Scenario "${scenario.name}" has no When step`);
                }
                if (!keywords.some((k: string) => k === 'Then')) {
                    warnings.push(`Scenario "${scenario.name}" has no Then step`);
                }
            }

            const isValid = issues.length === 0;

            if (isValid) {
                CSReporter.pass(`[MCP] Feature valid: ${featurePath}`);
            } else {
                CSReporter.warn(`[MCP] Feature has ${issues.length} issues: ${featurePath}`);
            }

            return createJsonResult({
                path: fullPath,
                valid: isValid,
                issues,
                warnings,
                scenarioCount: parsed.scenarios.length,
                stepCount: parsed.scenarios.reduce((sum: number, s: any) => sum + (s.steps?.length || 0), 0),
            });
        } catch (error: any) {
            CSReporter.fail(`[MCP] Validation failed: ${error.message}`);
            return createJsonResult({
                path: featurePath,
                valid: false,
                issues: [`Parse error: ${error.message}`],
                warnings: [],
            });
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Export all BDD tools
// ============================================================================

export const bddTools: MCPToolDefinition[] = [
    // Feature files
    listFeaturesTool,
    parseFeatureTool,
    runFeatureTool,
    runScenarioTool,

    // Step definitions
    listStepDefinitionsTool,

    // Scenario context
    getScenarioContextTool,
    setScenarioContextTool,
    clearScenarioContextTool,

    // Value resolution
    resolveValueTool,

    // Data sources
    loadDataSourceTool,

    // Suite execution
    runSuiteTool,

    // Validation
    validateFeatureTool,
];

/**
 * Register all BDD tools with the registry
 */
export function registerBDDTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(bddTools);
}
