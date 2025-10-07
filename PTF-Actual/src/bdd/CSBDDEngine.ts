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

// Simple UUID function for AstBuilder
function uuidFn(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export interface ParsedFeature {
    name: string;
    description?: string;
    tags: string[];
    scenarios: ParsedScenario[];
    background?: ParsedBackground;
    rules?: ParsedRule[];
    uri?: string;  // Path to the feature file
}

export interface ParsedScenario {
    name: string;
    tags: string[];
    steps: ParsedStep[];
    examples?: ParsedExamples;
    type: 'Scenario' | 'ScenarioOutline';
}

export interface ParsedStep {
    keyword: string;
    text: string;
    dataTable?: any[][];
    docString?: string;
}

export interface ParsedBackground {
    name?: string;
    steps: ParsedStep[];
}

export interface ParsedRule {
    name: string;
    scenarios: ParsedScenario[];
}

export interface ParsedExamples {
    name?: string;
    headers: string[];
    rows: string[][];
    dataSource?: ExternalDataSource;
}

export interface ExternalDataSource {
    type: 'excel' | 'csv' | 'json' | 'xml' | 'database' | 'api';
    source: string;
    sheet?: string;
    delimiter?: string;
    path?: string;
    xpath?: string;
    filter?: string;
    query?: string;
    connection?: string;
}

export class CSBDDEngine {
    private static instance: CSBDDEngine;
    private config: CSConfigurationManager;
    private features: Map<string, ParsedFeature> = new Map();
    private stepDefinitionPaths: string[] = [];
    private dataProviderConfigs: Map<string, string> = new Map();
    private tsNodeRegistered: boolean = false;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.initializeStepDefinitionPaths();
        this.registerTsNode();
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
                // Register ts-node to handle TypeScript files
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
                this.tsNodeRegistered = true;
                CSReporter.debug('ts-node registered for TypeScript step definition loading');
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

        // Parse and expand paths
        const paths = pathsConfig.split(';').map(p => {
            // Replace {project} placeholder
            p = p.replace('{project}', project);

            // Resolve relative to CWD
            return path.resolve(process.cwd(), p);
        });

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

                    // Check if this is a scenario outline with examples
                    if (child.scenario.examples && child.scenario.examples.length > 0 &&
                        child.scenario.examples.some((ex: any) => ex.tableBody && ex.tableBody.length > 0)) {
                        // Expand scenario outline into multiple scenarios
                        const expandedScenarios = this.expandScenarioOutline(child.scenario);
                        parsedFeature.scenarios.push(...expandedScenarios);
                    } else {
                        parsedFeature.scenarios.push(scenario);
                    }
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
            tags,
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
                    tags: (scenario.tags || []).map((t: any) => t.name),
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
    public async loadRequiredStepDefinitions(features: ParsedFeature[]): Promise<void> {
        const startTime = Date.now();

        if (!this.config.getBoolean('SELECTIVE_STEP_LOADING', true)) {
            // Load all step definitions
            await this.loadAllStepDefinitions();
            return;
        }

        // Extract all unique step patterns from features
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

        // Load only step files that contain matching patterns
        const loadedFiles: string[] = [];

        for (const stepPath of this.stepDefinitionPaths) {
            if (fs.existsSync(stepPath)) {
                const stat = fs.statSync(stepPath);

                if (stat.isDirectory()) {
                    const files = this.findStepFiles(stepPath);

                    for (const file of files) {
                        if (await this.fileContainsSteps(file, stepPatterns)) {
                            await this.loadStepFile(file);
                            loadedFiles.push(file);
                            CSReporter.debug(`Loaded file: ${file}`);
                        }
                    }
                } else if (stepPath.endsWith('.ts') || stepPath.endsWith('.js')) {
                    if (await this.fileContainsSteps(stepPath, stepPatterns)) {
                        await this.loadStepFile(stepPath);
                        loadedFiles.push(stepPath);
                    }
                }
            }
        }

        const loadTime = Date.now() - startTime;
        CSReporter.info(`Selective step loading: ${loadedFiles.length} files in ${loadTime}ms`);
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

    private async fileContainsSteps(filePath: string, stepPatterns: Set<string>): Promise<boolean> {
        const content = fs.readFileSync(filePath, 'utf8');

        // Check if file contains step definition decorators
        if (!content.includes('@CSBDDStepDef') && !content.includes('CSBDDStepDef(')) {
            return false;
        }

        // Check if file contains any of the step patterns
        for (const pattern of stepPatterns) {
            // For more flexible matching, check if the file contains the actual step definition text
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
                    // Be careful with order - more specific patterns first
                    const stepPattern = withoutKeyword
                        .replace(/"[^"]*"/g, '{string}')           // Replace quoted strings with {string}
                        .replace(/\b\d+\.\d+\b/g, '{float}')       // Replace floats (e.g., 3.14) with {float}
                        .replace(/\b\d+\b/g, '{int}')              // Replace integers with {int}
                        .replace(/\b(true|false)\b/gi, '{boolean}') // Replace booleans with {boolean}
                        .replace(/\{[^}]+\}/g, (match) => match);   // Keep existing placeholders as-is

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
            }
        }

        return false;
    }

    private async loadStepFile(filePath: string): Promise<void> {
        try {
            let fileToLoad = filePath;

            // When using ts-node, always prefer TypeScript files to avoid module instance issues
            // The issue is that requiring compiled JS files creates different module contexts
            if (filePath.endsWith('.ts')) {
                // For ts-node execution, always use the TypeScript file directly
                // This ensures the same module instance is used across all requires
                fileToLoad = filePath;
                CSReporter.debug(`Loading TypeScript file directly: ${filePath}`);
            } else if (filePath.endsWith('.js')) {
                // Try to find the TypeScript source if we have a JS file
                const tsPath = filePath.replace('/dist/', '/src/').replace('.js', '.ts');
                if (fs.existsSync(tsPath)) {
                    fileToLoad = tsPath;
                    CSReporter.debug(`Using TypeScript source: ${tsPath} instead of ${filePath}`);
                }
            }

            // Load and register the step definitions
            // Note: We don't clear the require cache here as it can cause issues with singleton patterns
            require(fileToLoad);
            CSReporter.debug(`Successfully loaded step file: ${path.basename(fileToLoad)}`);
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