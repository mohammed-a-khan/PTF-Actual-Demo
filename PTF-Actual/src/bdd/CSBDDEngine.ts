import * as fs from 'fs';
import * as path from 'path';
// Lazy load cucumber/gherkin for performance (saves 4s)
let gherkinModule: any = null;
const getGherkin = () => {
    if (!gherkinModule) {
        gherkinModule = require('@cucumber/gherkin');
    }
    return gherkinModule;
};

import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

//Import types from CSBDDTypes
import type {
    ParsedFeature,
    ParsedScenario,
    ParsedStep,
    ParsedBackground,
    ParsedRule,
    ParsedExamples,
    ExternalDataSource
} from './CSBDDTypes';

//Re-export types fro backward compatibility
export type {
    ParsedFeature,
    ParsedScenario,
    ParsedStep,
    ParsedBackground,
    ParsedRule,
    ParsedExamples,
    ExternalDataSource
} from './CSBDDTypes';

// Simple UUID function for AstBuilder
function uuidFn(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export class CSBDDEngine {
    private static instance: CSBDDEngine;
    private config: CSConfigurationManager;
    private features: Map<string, ParsedFeature> = new Map();
    private stepDefinitionPaths: string[] = [];
    private dataProviderConfigs: Map<string, string> = new Map();
    private tsNodeRegistered: boolean = false;

    // Global tags - Playwright 1.57 inspired testConfig.tag feature
    private globalTags: string[] = [];

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.initializeStepDefinitionPaths();
        this.initializeGlobalTags();
        this.registerTsNode();
    }

    // ============================================
    // GLOBAL TAG CONFIGURATION (Playwright 1.57+ inspired)
    // ============================================

    /**
     * Initialize global tags from configuration
     * Inspired by Playwright 1.57's testConfig.tag feature
     */
    private initializeGlobalTags(): void {
        // Load global tags from config (comma-separated)
        const configTags = this.config.get('GLOBAL_TAGS', '');
        if (configTags) {
            this.globalTags = configTags.split(',').map((t: string) => t.trim()).filter((t: string) => t);
            if (this.globalTags.length > 0) {
                CSReporter.info(`Global tags configured: ${this.globalTags.join(', ')}`);
            }
        }
    }

    /**
     * Set global tags that will be added to all scenarios
     * Similar to Playwright 1.57's testConfig.tag
     * @param tags Array of tag strings (e.g., ['@smoke', '@regression'])
     * @since Playwright 1.57 inspired
     */
    public setGlobalTags(tags: string[]): void {
        this.globalTags = tags.map(t => t.startsWith('@') ? t : `@${t}`);
        CSReporter.info(`Global tags set: ${this.globalTags.join(', ')}`);
    }

    /**
     * Add a single global tag
     * @param tag Tag string (e.g., '@smoke' or 'smoke')
     */
    public addGlobalTag(tag: string): void {
        const normalizedTag = tag.startsWith('@') ? tag : `@${tag}`;
        if (!this.globalTags.includes(normalizedTag)) {
            this.globalTags.push(normalizedTag);
            CSReporter.debug(`Global tag added: ${normalizedTag}`);
        }
    }

    /**
     * Remove a global tag
     * @param tag Tag string to remove
     */
    public removeGlobalTag(tag: string): void {
        const normalizedTag = tag.startsWith('@') ? tag : `@${tag}`;
        this.globalTags = this.globalTags.filter(t => t !== normalizedTag);
        CSReporter.debug(`Global tag removed: ${normalizedTag}`);
    }

    /**
     * Get current global tags
     * @returns Array of global tag strings
     */
    public getGlobalTags(): string[] {
        return [...this.globalTags];
    }

    /**
     * Clear all global tags
     */
    public clearGlobalTags(): void {
        this.globalTags = [];
        CSReporter.debug('Global tags cleared');
    }

    /**
     * Apply global tags to a scenario's tag list
     * @param scenarioTags Original scenario tags
     * @returns Merged tags array with global tags
     */
    private applyGlobalTags(scenarioTags: string[]): string[] {
        if (this.globalTags.length === 0) {
            return scenarioTags;
        }
        // Merge without duplicates
        const mergedTags = [...scenarioTags];
        for (const globalTag of this.globalTags) {
            if (!mergedTags.includes(globalTag)) {
                mergedTags.push(globalTag);
            }
        }
        return mergedTags;
    }

    /**
     * Register ts-node to enable loading TypeScript step definition files
     */
    private registerTsNode(): void {
        if (this.tsNodeRegistered) return;

        try {
            // Check if we're running in a TypeScript environment
            const hasTsFiles = this.stepDefinitionPaths.some(p => {
                if (fs.existsSync(p)) {
                    const stat = fs.statSync(p);
                    if (stat.isDirectory()) {
                        return fs.readdirSync(p).some(f => f.endsWith('.ts'));
                    }
                    return p.endsWith('.ts');
                }
                return false;
            });

            if (hasTsFiles) {
                // Register ts-node to handle TypeScript files with inline source maps for debugging
                require('ts-node').register({
                    transpileOnly: true,
                    compilerOptions: {
                        module: 'commonjs',
                        target: 'es2017',
                        esModuleInterop: true,
                        skipLibCheck: true,
                        experimentalDecorators: true,
                        emitDecoratorMetadata: true,
                        sourceMap: true,
                        inlineSourceMap: true,
                        inlineSources: true
                    }
                });
                this.tsNodeRegistered = true;
                CSReporter.debug('ts-node registered for TypeScript step definition loading with source map support');
            }
        } catch (error: any) {
            // ts-node may not be available, which is fine if only JS files are used
            CSReporter.debug(`ts-node not available: ${error.message}`);
        }
    }

    public static getInstance(): CSBDDEngine {
        if (!CSBDDEngine.instance) {
            CSBDDEngine.instance = new CSBDDEngine();
        }
        return CSBDDEngine.instance;
    }

    private initializeStepDefinitionPaths(): void {
        const pathsConfig = this.config.get('STEP_DEFINITIONS_PATH', 'test/common/steps;test/{project}/steps;src/steps');
        const project = this.config.get('PROJECT', 'common');

        // Only prefer dist/ when explicitly enabled (default: false - use source paths as configured)
        // This ensures STEP_DEFINITIONS_PATH from env files is respected by default
        const preferDist = this.config.getBoolean('PREFER_DIST_STEPS', false);

        // Parse and expand paths
        const paths: string[] = [];

        for (let p of pathsConfig.split(';')) {
            // Replace {project} placeholder
            p = p.replace('{project}', project);

            // Resolve relative to CWD
            const resolvedPath = path.resolve(process.cwd(), p);

            // If PREFER_DIST_STEPS=true, check for compiled dist/ version (performance optimization)
            // This avoids slow ts-node transpilation (1-2 seconds per file)
            if (preferDist) {
                // Case 1: src/ paths -> check dist/ (e.g., src/steps -> dist/steps)
                if (p.includes('/src/') || p.includes('\\src\\') || p.startsWith('src/') || p.startsWith('src\\')) {
                    const distPath = resolvedPath.replace(/[/\\]src[/\\]/, '/dist/').replace(/[/\\]src$/, '/dist');
                    if (fs.existsSync(distPath)) {
                        paths.push(distPath);
                        CSReporter.debug(`Using compiled: ${distPath}`);
                        continue;
                    }
                }

                // Case 2: Consumer project pattern - test/{project}/steps -> dist/test/{project}/steps
                // When tsconfig has outDir: "./dist" and rootDir: ".", compiled files go to dist/test/...
                if (p.startsWith('test/') || p.startsWith('test\\')) {
                    const distPath = path.resolve(process.cwd(), 'dist', p);
                    if (fs.existsSync(distPath)) {
                        paths.push(distPath);
                        CSReporter.debug(`Using compiled: ${distPath}`);
                        continue;
                    }
                }
            }

            // Default: Use source path as specified in STEP_DEFINITIONS_PATH
            paths.push(resolvedPath);
        }

        this.stepDefinitionPaths = paths;
    }

    // Public method to set step definition paths explicitly
    public setStepDefinitionPaths(paths: string[]): void {
        // Resolve relative to CWD
        this.stepDefinitionPaths = paths.map(p => path.resolve(process.cwd(), p));
        CSReporter.debug(`Step definition paths set to: ${this.stepDefinitionPaths.join(', ')}`);
    }

    // Parse single feature file
    public parseFeature(featurePath: string): ParsedFeature {
        const fullPath = path.resolve(process.cwd(), featurePath);

        if (!fs.existsSync(fullPath)) {
            throw new Error(`Feature file not found: ${fullPath}`);
        }

        const content = fs.readFileSync(fullPath, 'utf8');
        // Pass the full path instead of relative path
        return this.parseGherkin(content, fullPath);
    }

    // Parse feature with validation
    public parseFeatureWithValidation(featurePath: string): ParsedFeature {
        const feature = this.parseFeature(featurePath);
        this.validateFeature(feature);
        return feature;
    }

    // Parse directory of features
    public parseDirectory(dirPath: string): ParsedFeature[] {
        const fullPath = path.resolve(process.cwd(), dirPath);
        const features: ParsedFeature[] = [];

        if (!fs.existsSync(fullPath)) {
            CSReporter.warn(`Feature directory not found: ${fullPath}`);
            return features;
        }

        const files = this.findFeatureFiles(fullPath);

        for (const file of files) {
            try {
                const feature = this.parseFeature(file);
                features.push(feature);
                this.features.set(file, feature);
            } catch (error: any) {
                CSReporter.error(`Failed to parse feature: ${file} - ${error.message}`);
            }
        }

        return features;
    }

    // Parse with filters
    public parseWithFilters(dirPath: string, filters: {
        tags?: string;
        excludeTags?: string;
        scenario?: string;
    }): ParsedFeature[] {
        const features = this.parseDirectory(dirPath);

        if (!filters) return features;

        return features.map(feature => {
            const filteredScenarios = feature.scenarios.filter(scenario => {
                // Tag filtering
                if (filters.tags) {
                    const requiredTags = filters.tags.split(',').map(t => t.trim());
                    const scenarioTags = [...feature.tags, ...scenario.tags];

                    if (!requiredTags.some(tag => scenarioTags.includes(tag))) {
                        return false;
                    }
                }

                // Exclude tags
                if (filters.excludeTags) {
                    const excludedTags = filters.excludeTags.split(',').map(t => t.trim());
                    const scenarioTags = [...feature.tags, ...scenario.tags];

                    if (excludedTags.some(tag => scenarioTags.includes(tag))) {
                        return false;
                    }
                }

                // Scenario name filter
                if (filters.scenario) {
                    if (!scenario.name.includes(filters.scenario)) {
                        return false;
                    }
                }

                return true;
            });

            return {
                ...feature,
                scenarios: filteredScenarios
            };
        }).filter(feature => feature.scenarios.length > 0);
    }

    // Parse Gherkin text
    public parseGherkin(gherkinText: string, sourcePath?: string): ParsedFeature {
        try {
            // Preprocess the gherkin text to handle @DataProvider tags
            const processedText = this.preprocessDataProviderTags(gherkinText);

            const { Parser, AstBuilder, GherkinClassicTokenMatcher } = getGherkin();
        const parser = new Parser(new AstBuilder(uuidFn), new GherkinClassicTokenMatcher());
            const ast = parser.parse(processedText);

            if (!ast.feature) {
                throw new Error('No feature found in Gherkin text');
            }

            const feature = ast.feature;

            const featureTags = (feature.tags || []).map((t: any) => t.name);
            const parsedFeature: ParsedFeature = {
                name: feature.name || 'Unnamed Feature',
                description: feature.description,
                tags: featureTags,
                scenarios: [],
                uri: sourcePath,  // Add the source path
                background: undefined,
                rules: [],
                gherkinDocument: ast  // Store the raw gherkin document for scenario outline expansion
            } as any;

            // Check for feature-level @DataProvider tag
            const featureDataProviderTag = featureTags.find((tag: string) => tag.startsWith('@DataProvider'));

            // Parse children (background, scenarios, rules)
            for (const child of feature.children || []) {
                if (child.background) {
                    parsedFeature.background = {
                        name: child.background.name || 'Background',
                        steps: this.parseSteps([...child.background.steps])
                    };
                } else if (child.scenario) {
                    const scenario = this.parseScenario(child.scenario);

                    // If feature has @DataProvider and scenario doesn't have examples, apply feature-level data provider
                    if (featureDataProviderTag && !scenario.examples) {
                        scenario.examples = this.parseDataProviderTag(featureDataProviderTag);
                        scenario.type = 'ScenarioOutline';
                    }

                    // IMPORTANT: Do NOT expand scenario outlines at parse time!
                    // The orchestrator/runner will handle expansion into iterations with proper aggregation
                    // Always push the scenario as-is with its examples data
                    parsedFeature.scenarios.push(scenario);
                } else if (child.rule) {
                    parsedFeature.rules?.push(this.parseRule(child.rule));
                }
            }

            return parsedFeature;

        } catch (error: any) {
            throw new Error(`Failed to parse Gherkin: ${error.message}`);
        }
    }

    // Get AST
    public getAST(featurePath: string): any {
        const fullPath = path.resolve(process.cwd(), featurePath);
        const content = fs.readFileSync(fullPath, 'utf8');
        const { Parser, AstBuilder, GherkinClassicTokenMatcher } = getGherkin();
        const parser = new Parser(new AstBuilder(uuidFn), new GherkinClassicTokenMatcher());
        return parser.parse(content);
    }

    private parseScenario(scenario: any): ParsedScenario {
        const tags = (scenario.tags || []).map((t: any) => t.name);

        // Look for data provider configuration
        let dataProviderConfig: ExternalDataSource | null = null;

        // First check for @data-config tag (base64 encoded config)
        const configTag = tags.find((tag: string) => tag.startsWith('@data-config:'));
        if (configTag) {
            const base64Config = configTag.substring('@data-config:'.length);
            const configStr = Buffer.from(base64Config, 'base64').toString('utf-8');
            CSReporter.debug(`Extracted DataProvider config string from tag: ${configStr}`);
            dataProviderConfig = this.parseDataProviderString(configStr);
            CSReporter.debug(`Parsed DataProvider config object: ${JSON.stringify(dataProviderConfig)}`);
        }

        // If not found, try other methods
        if (!dataProviderConfig) {
            dataProviderConfig = this.extractDataProviderConfig(scenario);
        }

        // Check for @data-provider tag
        const hasDataProviderTag = tags.some((tag: string) =>
            tag === '@data-provider' ||
            tag === '@DataProvider' ||
            tag.includes('data-source') ||
            tag.includes('data-provider')
        );

        let examples = scenario.examples ? this.parseExamples(scenario.examples[0]) : undefined;

        CSReporter.debug(`Before creating examples - hasDataProviderTag: ${hasDataProviderTag}, dataProviderConfig: ${JSON.stringify(dataProviderConfig)}, examples: ${JSON.stringify(examples)}`);

        // If we have data provider configuration, create examples from it (override any empty examples)
        if (hasDataProviderTag && dataProviderConfig) {
            // Check if examples is empty or doesn't have a dataSource
            const hasEmptyExamples = !examples || (examples.headers.length === 0 && examples.rows.length === 0 && !examples.dataSource);

            if (hasEmptyExamples) {
                CSReporter.debug(`Creating examples from DataProvider config: ${JSON.stringify(dataProviderConfig)}`);
                examples = this.createExamplesFromConfig(dataProviderConfig);
                CSReporter.debug(`Created examples: ${JSON.stringify(examples)}`);
            }
        } else if (hasDataProviderTag && !dataProviderConfig) {
            CSReporter.warn(`@data-provider tag found but no configuration extracted`);
            CSReporter.debug(`hasDataProviderTag: ${hasDataProviderTag}, dataProviderConfig: ${JSON.stringify(dataProviderConfig)}`);
        }

        // Only include examples if they actually have data or a dataSource
        const hasActualExamples = examples && (
            (examples.rows.length > 0) ||
            examples.dataSource ||
            (examples.headers.length > 0)
        );

        return {
            name: scenario.name || 'Unnamed Scenario',
            tags: this.applyGlobalTags(tags),  // Apply global tags (Playwright 1.57 inspired)
            steps: this.parseSteps(scenario.steps),
            examples: hasActualExamples ? examples : undefined,
            type: (hasActualExamples || (hasDataProviderTag && dataProviderConfig)) ? 'ScenarioOutline' : 'Scenario'
        };
    }

    private expandScenarioOutline(scenario: any): ParsedScenario[] {
        const expandedScenarios: ParsedScenario[] = [];

        if (!scenario.examples || scenario.examples.length === 0) {
            return [this.parseScenario(scenario)];
        }

        for (const example of scenario.examples) {
            if (!example.tableBody || example.tableBody.length === 0) continue;

            const headers = example.tableHeader?.cells?.map((c: any) => c.value) || [];

            for (const row of example.tableBody) {
                const values = row.cells.map((c: any) => c.value);
                const exampleData: Record<string, string> = {};

                headers.forEach((header: string, index: number) => {
                    exampleData[header] = values[index] || '';
                });

                // Create a scenario name with example values
                const exampleValues = values.join(', ');
                const scenarioName = `${scenario.name} [${exampleValues}]`;

                // Replace placeholders in steps
                const expandedSteps = scenario.steps.map((step: any) => {
                    let text = step.text;
                    headers.forEach((header: string, index: number) => {
                        const placeholder = `<${header}>`;
                        const value = values[index] || '';
                        text = text.replace(new RegExp(placeholder, 'g'), value);
                    });

                    return {
                        keyword: step.keyword,
                        text: text,
                        dataTable: step.dataTable,
                        docString: step.docString
                    };
                });

                expandedScenarios.push({
                    name: scenarioName,
                    tags: this.applyGlobalTags((scenario.tags || []).map((t: any) => t.name)),  // Apply global tags (Playwright 1.57 inspired)
                    steps: this.parseSteps(expandedSteps),
                    type: 'Scenario',  // Expanded scenarios are regular scenarios
                    exampleData: exampleData  // Store the example data for reference
                } as any);
            }
        }

        return expandedScenarios.length > 0 ? expandedScenarios : [this.parseScenario(scenario)];
    }

    private parseRule(rule: any): ParsedRule {
        return {
            name: rule.name || 'Unnamed Rule',
            scenarios: (rule.children || [])
                .filter((child: any) => child.scenario)
                .map((child: any) => this.parseScenario(child.scenario))
        };
    }

    private parseSteps(steps: any[]): ParsedStep[] {
        return (steps || []).map(step => ({
            keyword: step.keyword.trim(),
            text: step.text,
            dataTable: step.dataTable ? this.parseDataTable(step.dataTable) : undefined,
            docString: step.docString ? step.docString.content : undefined
        }));
    }

    private parseDataTable(dataTable: any): any[][] {
        return dataTable.rows.map((row: any) =>
            row.cells.map((cell: any) => cell.value)
        );
    }

    private parseExamples(examples: any): ParsedExamples {
        if (!examples) return { headers: [], rows: [] };

        // Check if examples has external data source configuration
        // Format: Examples: {"type": "excel", "source": "testdata/users.xlsx", "sheet": "LoginData"}
        if (examples.name && examples.name.startsWith('{')) {
            try {
                const dataSource = JSON.parse(examples.name) as ExternalDataSource;
                return {
                    name: examples.name,
                    headers: [],  // Will be populated from external source
                    rows: [],     // Will be populated from external source
                    dataSource
                };
            } catch (error) {
                CSReporter.warn(`Failed to parse external data source config: ${examples.name}`);
            }
        }

        // Standard inline examples table
        const headers = examples.tableHeader
            ? examples.tableHeader.cells.map((cell: any) => cell.value)
            : [];

        const rows = (examples.tableBody || []).map((row: any) =>
            row.cells.map((cell: any) => cell.value)
        );

        return {
            name: examples.name,
            headers,
            rows
        };
    }

    private parseDataProviderTag(tag: string): ParsedExamples | undefined {
        // Parse @DataProvider(source="file.xlsx", type="excel", sheet="Sheet1", filter="active=true")
        const match = tag.match(/@DataProvider\((.*)\)/);
        if (!match) return undefined;

        try {
            // Parse the parameters
            const paramsStr = match[1];
            const params: any = {};

            // Simple regex to extract key-value pairs
            const paramRegex = /(\w+)="([^"]*)"/g;
            let paramMatch;
            while ((paramMatch = paramRegex.exec(paramsStr)) !== null) {
                params[paramMatch[1]] = paramMatch[2];
            }

            // Create ExternalDataSource from parsed params
            const dataSource: ExternalDataSource = {
                type: params.type || this.inferTypeFromSource(params.source),
                source: params.source,
                sheet: params.sheet,
                delimiter: params.delimiter,
                path: params.path,
                xpath: params.xpath,
                filter: params.filter,
                query: params.query,
                connection: params.connection
            };

            return {
                name: tag,
                headers: [],  // Will be populated from external source
                rows: [],     // Will be populated from external source
                dataSource
            };
        } catch (error) {
            CSReporter.warn(`Failed to parse @DataProvider tag: ${tag}`);
            return undefined;
        }
    }

    private inferTypeFromSource(source: string): 'excel' | 'csv' | 'json' | 'xml' | 'database' | 'api' {
        if (source.endsWith('.xlsx') || source.endsWith('.xls')) return 'excel';
        if (source.endsWith('.csv')) return 'csv';
        if (source.endsWith('.json')) return 'json';
        if (source.endsWith('.xml')) return 'xml';
        return 'csv'; // Default
    }

    private extractDataProviderConfig(scenario: any): ExternalDataSource | null {
        // First check if scenario has dataProviderConfig property (set during preprocessing)
        if ((scenario as any).dataProviderConfig) {
            return (scenario as any).dataProviderConfig;
        }

        // Look for data provider configuration in scenario description or docString
        // The preprocessing adds it as a docString: """DataProvider: ..."""
        let configString = '';

        // Check if first step has a docString with DataProvider config
        if (scenario.steps && scenario.steps.length > 0) {
            const firstStep = scenario.steps[0];
            if (firstStep.docString && firstStep.docString.content) {
                const content = firstStep.docString.content;
                const match = content.match(/DataProvider:\s*(.+)/);
                if (match) {
                    configString = match[1];
                    // Remove this special docString from steps
                    scenario.steps = scenario.steps.slice(1);
                }
            }
        }

        // Also check description field
        if (!configString) {
            const description = scenario.description || '';
            const descriptionMatch = description.match(/DataProvider:\s*(.+)/);
            if (descriptionMatch) {
                configString = descriptionMatch[1];
            }
        }

        // Check if we have stored configuration from preprocessing
        if (!configString && this.dataProviderConfigs && scenario.name) {
            const storedConfig = this.dataProviderConfigs.get(scenario.name);
            if (storedConfig) {
                CSReporter.debug(`Found stored DataProvider config for ${scenario.name}: ${storedConfig}`);
                configString = storedConfig;
            }
        }

        if (configString) {
            return this.parseDataProviderString(configString);
        }

        return null;
    }

    private parseDataProviderString(configStr: string): ExternalDataSource | null {
        try {
            const params: any = {};

            // Parse key="value" pairs
            const paramRegex = /(\w+)="([^"]*)"/g;
            let match;
            while ((match = paramRegex.exec(configStr)) !== null) {
                params[match[1]] = match[2];
            }

            if (!params.source) return null;

            return {
                type: params.type || this.inferTypeFromSource(params.source),
                source: params.source,
                sheet: params.sheet,
                delimiter: params.delimiter,
                path: params.path,
                xpath: params.xpath,
                filter: params.filter,
                query: params.query,
                connection: params.connection
            };
        } catch {
            return null;
        }
    }

    private createExamplesFromConfig(config: ExternalDataSource): ParsedExamples {
        return {
            name: `DataProvider: ${config.source}`,
            headers: [],  // Will be populated from external source
            rows: [],     // Will be populated from external source
            dataSource: config
        };
    }

    private preprocessDataProviderTags(gherkinText: string): string {
        // Store DataProvider configurations and replace with simple tags
        const lines = gherkinText.split('\n');
        const processedLines: string[] = [];
        this.dataProviderConfigs = new Map<string, string>();
        let pendingConfig: string | null = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();

            // Check if line contains @DataProvider(...)
            const dataProviderMatch = line.match(/@DataProvider\([^)]+\)/g);

            if (dataProviderMatch) {
                // Extract configuration
                dataProviderMatch.forEach(match => {
                    pendingConfig = match.substring('@DataProvider('.length, match.length - 1);
                });

                // Replace @DataProvider(...) with @data-provider tag and add config as comment
                let processedLine = line;
                dataProviderMatch.forEach(match => {
                    // Add config as a comment tag
                    processedLine = processedLine.replace(match, `@data-provider @data-config:${Buffer.from(pendingConfig || '').toString('base64')}`);
                });

                processedLines.push(processedLine);
                CSReporter.debug(`Found @DataProvider tag, storing config: ${pendingConfig}`);
                pendingConfig = null; // Reset after use
            } else {
                processedLines.push(line);
            }
        }

        const processedText = processedLines.join('\n');
        // CSReporter.debug(`Preprocessed Gherkin:\n${processedText}`);
        return processedText;
    }

    private findFeatureFiles(dirPath: string): string[] {
        const files: string[] = [];

        const items = fs.readdirSync(dirPath);

        for (const item of items) {
            const fullPath = path.join(dirPath, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                files.push(...this.findFeatureFiles(fullPath));
            } else if (item.endsWith('.feature')) {
                files.push(fullPath);
            }
        }

        return files;
    }

    private validateFeature(feature: ParsedFeature): void {
        // Validate all steps have definitions
        for (const scenario of feature.scenarios) {
            for (const step of scenario.steps) {
                // This would check against registered step definitions
                // For now, just log
                CSReporter.debug(`Validating step: ${step.keyword} ${step.text}`);
            }
        }
    }

    // Selective step loading based on features
    // OPTIMIZED: Uses pattern scanning for fast startup when LAZY_STEP_LOADING is enabled
    public async loadRequiredStepDefinitions(features: ParsedFeature[]): Promise<void> {
        const startTime = Date.now();

        // LAZY_STEP_LOADING is enabled by default for fast startup (30-60x faster)
        // Set LAZY_STEP_LOADING=false or --lazy-steps=false to disable
        const lazyStepLoading = this.config.getBoolean('LAZY_STEP_LOADING', true);

        // Get consumer step paths (excluding framework paths)
        const consumerStepPaths = this.stepDefinitionPaths.filter(stepPath => {
            // Skip framework paths - they are handled by CSStepLoader
            if (stepPath.includes('node_modules') && stepPath.includes('cs-playwright-test-framework')) {
                CSReporter.debug(`[StepLoading] Skipping framework path (handled by CSStepLoader): ${stepPath}`);
                return false;
            }
            return fs.existsSync(stepPath);
        });

        if (consumerStepPaths.length === 0) {
            CSReporter.debug('[StepLoading] No consumer step paths found');
            return;
        }

        if (lazyStepLoading) {
            // FAST PATH: Use pattern scanning - no require() calls, just file reading
            // This is 30-60x faster than loading all files upfront
            const { CSStepPatternScanner } = await import('./CSStepPatternScanner');
            const scanner = CSStepPatternScanner.getInstance();

            // Scan step files for patterns (fast - just reads source files)
            await scanner.scanStepFiles(consumerStepPaths);

            // Load only the step files that match steps in the features
            await scanner.loadStepsForFeatures(features);

            const stats = scanner.getStats();
            const loadTime = Date.now() - startTime;
            CSReporter.info(`[StepLoading] ✅ Lazy loading: scanned ${stats.files} files, loaded ${stats.loaded} needed files in ${loadTime}ms`);
            return;
        }

        // LEGACY PATH: Load all step files upfront (slower but compatible with all code)
        // Discover all step files from configured paths
        const stepFiles: string[] = [];

        for (const stepPath of consumerStepPaths) {
            const stat = fs.statSync(stepPath);

            if (stat.isDirectory()) {
                const files = this.findStepFiles(stepPath);
                stepFiles.push(...files);
            } else if (this.isStepFile(stepPath)) {
                stepFiles.push(stepPath);
            }
        }

        if (stepFiles.length === 0) {
            CSReporter.debug('[StepLoading] No consumer step files found in configured paths');
            return;
        }

        CSReporter.info(`[StepLoading] Found ${stepFiles.length} consumer step files to load`);

        // Load all step files - no content analysis needed (VDI optimization)
        // The decorator registration happens during require() and handles step matching
        const loadedFiles: string[] = [];
        const errors: string[] = [];

        for (const file of stepFiles) {
            try {
                await this.loadStepFile(file);
                loadedFiles.push(file);
            } catch (error: any) {
                errors.push(`${path.basename(file)}: ${error.message}`);
            }
        }

        const loadTime = Date.now() - startTime;

        if (errors.length > 0) {
            CSReporter.warn(`[StepLoading] ${errors.length} files failed to load: ${errors.join('; ')}`);
        }

        CSReporter.info(`[StepLoading] ✅ Loaded ${loadedFiles.length} consumer step files in ${loadTime}ms`);
    }

    /**
     * Check if a file is a step definition file
     */
    private isStepFile(filePath: string): boolean {
        const fileName = path.basename(filePath);
        return (
            fileName.endsWith('.steps.ts') ||
            fileName.endsWith('.steps.js') ||
            fileName.endsWith('.step.ts') ||
            fileName.endsWith('.step.js') ||
            fileName.endsWith('Steps.ts') ||
            fileName.endsWith('Steps.js')
        ) && !fileName.includes('.spec.') && !fileName.includes('.test.');
    }

    private async loadAllStepDefinitions(): Promise<void> {
        for (const stepPath of this.stepDefinitionPaths) {
            if (fs.existsSync(stepPath)) {
                const stat = fs.statSync(stepPath);

                if (stat.isDirectory()) {
                    const files = this.findStepFiles(stepPath);
                    for (const file of files) {
                        await this.loadStepFile(file);
                    }
                } else {
                    await this.loadStepFile(stepPath);
                }
            }
        }
    }

    private findStepFiles(dirPath: string): string[] {
        const files: string[] = [];
        const items = fs.readdirSync(dirPath);
        const seenBasenames = new Set<string>();

        for (const item of items) {
            const fullPath = path.join(dirPath, item);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                files.push(...this.findStepFiles(fullPath));
            } else if (item.endsWith('.js') || item.endsWith('.ts')) {
                // PERFORMANCE: Prefer .js files over .ts files to avoid ts-node transpilation
                // If both .ts and .js exist, only include .js
                const basename = item.replace(/\.(ts|js)$/, '');

                if (!seenBasenames.has(basename)) {
                    // Check if .js version exists (prefer it)
                    const jsVersion = path.join(dirPath, basename + '.js');
                    const tsVersion = path.join(dirPath, basename + '.ts');

                    if (fs.existsSync(jsVersion)) {
                        files.push(jsVersion);
                    } else if (fs.existsSync(tsVersion)) {
                        files.push(tsVersion);
                    }
                    seenBasenames.add(basename);
                }
            }
        }

        return files;
    }

    private async loadStepFile(filePath: string): Promise<void> {
        try {
            let fileToLoad = filePath;

            // Only prefer compiled dist/ files when PREFER_DIST_STEPS=true
            const preferDist = this.config.getBoolean('PREFER_DIST_STEPS', false);

            // PERFORMANCE OPTIMIZATION: Prefer compiled JS files over TypeScript transpilation
            // ts-node transpilation is slow (can take 1-2 seconds per file)
            // Compiled JS files load in milliseconds
            if (preferDist && filePath.endsWith('.ts')) {
                const cwd = process.cwd();

                // Case 1: src/ paths -> dist/ (e.g., src/steps/file.ts -> dist/steps/file.js)
                if (filePath.includes(`${path.sep}src${path.sep}`) || filePath.includes('/src/')) {
                    const jsPath = filePath
                        .replace(`${path.sep}src${path.sep}`, `${path.sep}dist${path.sep}`)
                        .replace('/src/', '/dist/')
                        .replace('.ts', '.js');
                    if (fs.existsSync(jsPath)) {
                        fileToLoad = jsPath;
                        CSReporter.debug(`Using compiled: ${path.basename(jsPath)}`);
                    }
                }

                // Case 2: Consumer project - test/project/steps/file.ts -> dist/test/project/steps/file.js
                // Get relative path from CWD
                if (fileToLoad === filePath) {
                    const relativePath = path.relative(cwd, filePath);
                    if (relativePath.startsWith('test') || relativePath.startsWith(`test${path.sep}`)) {
                        const distPath = path.join(cwd, 'dist', relativePath.replace('.ts', '.js'));
                        if (fs.existsSync(distPath)) {
                            fileToLoad = distPath;
                            CSReporter.debug(`Using compiled: ${path.basename(distPath)}`);
                        }
                    }
                }

                // Still .ts file - will use ts-node (slower)
                if (fileToLoad === filePath) {
                    CSReporter.debug(`Loading via ts-node: ${path.basename(filePath)} (no compiled JS found)`);
                }
            }
            // For .js files, use them directly (already compiled)

            // Load and register the step definitions
            require(fileToLoad);
            CSReporter.debug(`Loaded: ${path.basename(fileToLoad)}`);
        } catch (error: any) {
            CSReporter.error(`Failed to load step file: ${filePath} - ${error.message}`);
        }
    }

    // Get all loaded features
    public getFeatures(): Map<string, ParsedFeature> {
        return this.features;
    }

    // Clear cached features
    public clearFeatures(): void {
        this.features.clear();
    }
}