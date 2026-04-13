/**
 * CS Playwright MCP Migration Tools
 *
 * Converts Selenium/Java/QAF test projects to CS Playwright TypeScript.
 * AI reads Java source code and extracts structured data.
 * These tools receive that structured data, enforce framework rules,
 * detect duplicates, generate compliant code, and validate against
 * the live application via Playwright MCP.
 *
 * Tools:
 *   migrate_scan_files        — Scan source folder, categorize files
 *   migrate_convert_page      — Convert page object from structured input
 *   migrate_convert_steps     — Convert step definitions with duplicate detection
 *   migrate_convert_data      — Convert Excel/CSV data to JSON format
 *   migrate_extract_queries   — Extract SQL queries to .env format
 *   migrate_generate_config   — Generate complete project config scaffold
 *   migrate_validate_locators — Validate locators against live app (uses Playwright MCP)
 *
 * @module CSMCPMigrationTools
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    MCPToolDefinition,
    MCPToolResult,
    MCPTextContent,
    ToolCategory,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';

// ============================================================================
// Helpers
// ============================================================================

function textResult(text: string): MCPToolResult {
    return { content: [{ type: 'text', text } as MCPTextContent] };
}

function jsonResult(data: unknown): MCPToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) } as MCPTextContent],
        structuredContent: data as Record<string, unknown>,
    };
}

function errorResult(message: string): MCPToolResult {
    return { content: [{ type: 'text', text: `Error: ${message}` } as MCPTextContent], isError: true };
}

function toPascalCase(s: string): string {
    return s.replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^./, c => c.toUpperCase());
}

function toKebabCase(s: string): string {
    return s.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase();
}

function toCamelCase(s: string): string {
    const p = toPascalCase(s);
    return p.charAt(0).toLowerCase() + p.slice(1);
}

function escStr(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// ============================================================================
// Tool 1: migrate_scan_files
// ============================================================================

const migrateScanFilesTool = defineTool()
    .name('migrate_scan_files')
    .description('Scan a Selenium/Java source folder and categorize all files for migration. Returns a structured inventory of page objects, step definitions, feature files, data files, utility classes, and database operations found.')
    .category('generation')
    .stringParam('sourcePath', 'Path to the Selenium/Java project source folder', { required: true })
    .handler(async (params, context) => {
        const sourcePath = params.sourcePath as string;

        if (!fs.existsSync(sourcePath)) {
            return errorResult(`Source path does not exist: ${sourcePath}`);
        }

        context.log('info', `Scanning source folder: ${sourcePath}`);

        const inventory: {
            pages: { file: string; className: string; elementCount: number }[];
            steps: { file: string; className: string; stepCount: number }[];
            features: { file: string; scenarioCount: number }[];
            dataFiles: { file: string; type: string }[];
            utilities: { file: string; className: string }[];
            configs: { file: string; type: string }[];
            totalFiles: number;
        } = {
            pages: [],
            steps: [],
            features: [],
            dataFiles: [],
            utilities: [],
            configs: [],
            totalFiles: 0,
        };

        function scanDir(dir: string): void {
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'target') continue;
                    scanDir(fullPath);
                    continue;
                }

                inventory.totalFiles++;
                const rel = path.relative(sourcePath, fullPath);
                const ext = path.extname(entry.name).toLowerCase();

                if (ext === '.java') {
                    let content = '';
                    try { content = fs.readFileSync(fullPath, 'utf-8'); } catch { continue; }

                    const classMatch = content.match(/class\s+(\w+)/);
                    const className = classMatch ? classMatch[1] : entry.name.replace('.java', '');

                    // Detect page objects
                    if (content.includes('@FindBy') || content.includes('WebElement') ||
                        content.includes('QAFWebElement') || /extends\s+.*Page/i.test(content) ||
                        /Page\s*\{/.test(content)) {
                        const elementCount = (content.match(/@FindBy/g) || []).length +
                            (content.match(/QAFWebElement/g) || []).length;
                        inventory.pages.push({ file: rel, className, elementCount });
                    }
                    // Detect step definitions
                    else if (content.includes('@QAFTestStep') || content.includes('@Given') ||
                        content.includes('@When') || content.includes('@Then') ||
                        content.includes('@And') || content.includes('@QAFTestStepProvider')) {
                        const stepCount = (content.match(/@(?:QAFTestStep|Given|When|Then|And|But)\s*\(/g) || []).length;
                        inventory.steps.push({ file: rel, className, stepCount });
                    }
                    // Detect utilities / DB helpers
                    else if (content.includes('Connection') || content.includes('PreparedStatement') ||
                        content.includes('ResultSet') || content.includes('DriverManager')) {
                        inventory.utilities.push({ file: rel, className });
                    }
                    // Generic utility
                    else if (content.includes('public static') || /Helper|Util|Common/i.test(className)) {
                        inventory.utilities.push({ file: rel, className });
                    }
                }
                // Feature files
                else if (ext === '.feature') {
                    let content = '';
                    try { content = fs.readFileSync(fullPath, 'utf-8'); } catch { continue; }
                    const scenarioCount = (content.match(/Scenario(?:\s+Outline)?:/g) || []).length;
                    inventory.features.push({ file: rel, scenarioCount });
                }
                // Data files
                else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
                    inventory.dataFiles.push({ file: rel, type: ext.replace('.', '') });
                }
                // Config files
                else if (ext === '.properties' || entry.name === 'testng.xml' || entry.name === 'pom.xml') {
                    inventory.configs.push({ file: rel, type: ext.replace('.', '') || 'xml' });
                }
            }
        }

        scanDir(sourcePath);

        context.log('info', `Scan complete: ${inventory.pages.length} pages, ${inventory.steps.length} step files, ${inventory.features.length} features, ${inventory.dataFiles.length} data files`);

        return jsonResult({
            summary: {
                totalFiles: inventory.totalFiles,
                pages: inventory.pages.length,
                stepFiles: inventory.steps.length,
                totalSteps: inventory.steps.reduce((sum, s) => sum + s.stepCount, 0),
                features: inventory.features.length,
                totalScenarios: inventory.features.reduce((sum, f) => sum + f.scenarioCount, 0),
                dataFiles: inventory.dataFiles.length,
                utilities: inventory.utilities.length,
                configs: inventory.configs.length,
            },
            inventory,
            migrationOrder: [
                '1. Config files (env, global settings)',
                '2. Page objects (elements + methods)',
                '3. Database helpers (SQL queries)',
                '4. Step definitions (with duplicate detection)',
                '5. Test data (Excel/CSV → JSON)',
                '6. Feature files (Gherkin conversion)',
            ],
        });
    })
    .build();

// ============================================================================
// Tool 1b: migrate_read_file
// ============================================================================

const migrateReadFileTool = defineTool()
    .name('migrate_read_file')
    .description('Read the contents of a source file (Java, properties, XML, feature, etc.) for migration analysis. Use this after migrate_scan_files to read individual files.')
    .category('generation')
    .stringParam('filePath', 'Absolute path to the file to read', { required: true })
    .handler(async (params, context) => {
        const filePath = params.filePath as string;

        if (!fs.existsSync(filePath)) {
            return errorResult(`File does not exist: ${filePath}`);
        }

        try {
            const stats = fs.statSync(filePath);
            if (stats.size > 500000) {
                return errorResult(`File too large (${stats.size} bytes). Maximum is 500KB.`);
            }

            const content = fs.readFileSync(filePath, 'utf-8');
            context.log('info', `Read file: ${filePath} (${content.length} chars)`);

            return jsonResult({
                filePath,
                size: stats.size,
                lines: content.split('\n').length,
                content,
            });
        } catch (err: any) {
            return errorResult(`Failed to read file: ${err.message}`);
        }
    })
    .build();

// ============================================================================
// Tool 2: migrate_convert_page
// ============================================================================

const migrateConvertPageTool = defineTool()
    .name('migrate_convert_page')
    .description('Generate a CS Playwright page object from structured element/method data extracted by AI from Java source. Enforces all framework patterns: @CSPage, @CSGetElement, initializeElements(), correct imports, no raw Playwright APIs.')
    .category('generation')
    .stringParam('pageName', 'Page name without "Page" suffix (e.g., "Login", "Dashboard")', { required: true })
    .stringParam('project', 'Project name for import paths and file naming', { required: true })
    .arrayParam('elements', 'Array of element definitions: [{name, locator, locatorType, description}]', 'object', { required: true })
    .arrayParam('methods', 'Array of method definitions: [{name, actions, description, returnType}]', 'object')
    .stringParam('pageUrl', 'Page URL pattern for navigation')
    .stringParam('outputDir', 'Output directory (default: test/{project}/pages)')
    .handler(async (params, context) => {
        const pageName = params.pageName as string;
        const project = params.project as string;
        const elements = params.elements as Array<{
            name: string;
            locator: string;
            locatorType?: 'xpath' | 'css' | 'testId' | 'text' | 'role';
            description?: string;
            waitForVisible?: boolean;
            selfHeal?: boolean;
            alternativeLocators?: string[];
        }>;
        const methods = (params.methods || []) as Array<{
            name: string;
            actions: Array<{ type: string; element?: string; value?: string; description?: string }>;
            description?: string;
            returnType?: string;
        }>;
        const pageUrl = params.pageUrl as string | undefined;
        const outputDir = (params.outputDir as string) || `test/${project}/pages`;

        const className = `${toPascalCase(project)}${toPascalCase(pageName)}Page`;
        const pageId = `${toKebabCase(project)}-${toKebabCase(pageName)}`;
        const fileName = `${className}.ts`;

        context.log('info', `Generating page object: ${className} with ${elements.length} elements, ${methods.length} methods`);

        // Generate element declarations
        const elementDecls = elements.map(el => {
            const locType = el.locatorType || (el.locator.startsWith('/') || el.locator.startsWith('(') ? 'xpath' : 'css');
            const opts: string[] = [];
            opts.push(`${locType}: '${escStr(el.locator)}'`);
            opts.push(`description: '${escStr(el.description || `${toPascalCase(el.name)} element`)}'`);
            if (el.waitForVisible) opts.push('waitForVisible: true');
            if (el.selfHeal) opts.push('selfHeal: true');
            if (el.alternativeLocators && el.alternativeLocators.length > 0) {
                opts.push(`alternativeLocators: [${el.alternativeLocators.map(a => `'${escStr(a)}'`).join(', ')}]`);
            }
            return `    @CSGetElement({\n        ${opts.join(',\n        ')}\n    })\n    public ${toCamelCase(el.name)}!: CSWebElement;`;
        }).join('\n\n');

        // Generate methods
        const methodDecls = methods.map(m => {
            const returnType = m.returnType || 'Promise<void>';
            const bodyLines: string[] = [];

            if (m.description) {
                bodyLines.push(`        CSReporter.info('${escStr(m.description)}');`);
            }

            for (const action of m.actions) {
                const elRef = action.element ? `this.${toCamelCase(action.element)}` : 'this.page';
                switch (action.type) {
                    case 'click':
                        bodyLines.push(`        await ${elRef}.click();`);
                        break;
                    case 'fill':
                        bodyLines.push(`        await ${elRef}.fill(${action.value || "''"});`);
                        break;
                    case 'clear':
                        bodyLines.push(`        await ${elRef}.clear();`);
                        break;
                    case 'selectOption':
                        bodyLines.push(`        await ${elRef}.selectOption(${action.value || "''"});`);
                        break;
                    case 'hover':
                        bodyLines.push(`        await ${elRef}.hover();`);
                        break;
                    case 'getText':
                        bodyLines.push(`        return await ${elRef}.textContent() || '';`);
                        break;
                    case 'isVisible':
                        bodyLines.push(`        return await ${elRef}.isVisible();`);
                        break;
                    case 'navigate':
                        bodyLines.push(`        await this.page.goto(${action.value || `'${pageUrl || '/'}'`});`);
                        break;
                    case 'waitForVisible':
                        bodyLines.push(`        await ${elRef}.waitForVisible();`);
                        break;
                    case 'custom':
                        bodyLines.push(`        ${action.description || '// Custom logic — review needed'}`);
                        break;
                    default:
                        bodyLines.push(`        // TODO: Review — ${action.type} action on ${action.element || 'page'}`);
                }
            }

            return `\n    public async ${toCamelCase(m.name)}(${m.actions.some(a => a.value?.startsWith('param:')) ? m.actions.filter(a => a.value?.startsWith('param:')).map(a => `${a.value!.replace('param:', '')}: string`).join(', ') : ''}): ${returnType} {\n${bodyLines.join('\n')}\n    }`;
        }).join('\n');

        // Assemble the page class
        const code = `import { CSBasePage, CSPage, CSGetElement } from '@cs-playwright/core';
import { CSWebElement } from '@cs-playwright/element';
import { CSReporter } from '@cs-playwright/reporting';

@CSPage('${pageId}')
export class ${className} extends CSBasePage {

    protected initializeElements(): void {
        CSReporter.debug('${className} elements initialized');
    }

${elementDecls}
${methodDecls}
}
`;

        // Write file
        const outPath = path.resolve(outputDir, fileName);
        try {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, code, 'utf-8');
            context.log('info', `Page object written: ${outPath}`);
        } catch (err: any) {
            return errorResult(`Failed to write file: ${err.message}`);
        }

        return jsonResult({
            className,
            fileName,
            filePath: outPath,
            elements: elements.length,
            methods: methods.length,
            code,
        });
    })
    .build();

// ============================================================================
// Tool 3: migrate_convert_steps
// ============================================================================

const migrateConvertStepsTool = defineTool()
    .name('migrate_convert_steps')
    .description('Generate CS Playwright step definitions from structured step data. Detects duplicates against existing step files and built-in framework steps. Enforces @CSBDDStepDef pattern, correct imports, CSReporter logging, no raw APIs.')
    .category('generation')
    .stringParam('moduleName', 'Module name for the step file (e.g., "login", "deal-series")', { required: true })
    .stringParam('project', 'Project name', { required: true })
    .arrayParam('steps', 'Array of step definitions: [{pattern, keyword, body, pageRefs, description}]', 'object', { required: true })
    .arrayParam('pageImports', 'Page classes to import: [{className, importPath}]', 'object')
    .stringParam('existingStepsDir', 'Path to existing step files for duplicate detection')
    .stringParam('outputDir', 'Output directory (default: test/{project}/steps)')
    .handler(async (params, context) => {
        const moduleName = params.moduleName as string;
        const project = params.project as string;
        const steps = params.steps as Array<{
            pattern: string;
            keyword: 'Given' | 'When' | 'Then' | 'And';
            body: string[];
            pageRefs?: string[];
            description?: string;
            scenarioContextVars?: { get?: string[]; set?: string[] };
        }>;
        const pageImports = (params.pageImports || []) as Array<{ className: string; importPath: string }>;
        const existingStepsDir = params.existingStepsDir as string | undefined;
        const outputDir = (params.outputDir as string) || `test/${project}/steps`;

        const fileName = `${toKebabCase(project)}-${toKebabCase(moduleName)}.steps.ts`;
        const className = `${toPascalCase(project)}${toPascalCase(moduleName)}Steps`;

        context.log('info', `Generating step definitions: ${className} with ${steps.length} steps`);

        // Duplicate detection
        const existingPatterns = new Set<string>();
        if (existingStepsDir && fs.existsSync(existingStepsDir)) {
            const files = fs.readdirSync(existingStepsDir).filter(f => f.endsWith('.steps.ts'));
            for (const file of files) {
                try {
                    const content = fs.readFileSync(path.join(existingStepsDir, file), 'utf-8');
                    const matches = content.matchAll(/@CSBDDStepDef\(['"`](.+?)['"`]\)/g);
                    for (const match of matches) {
                        existingPatterns.add(match[1]);
                    }
                } catch { /* skip unreadable files */ }
            }
        }

        // Also check built-in framework steps directory
        const builtInDirs = [
            path.resolve('node_modules/@cs-playwright/dist/steps'),
            path.resolve('dist/steps'),
        ];
        for (const dir of builtInDirs) {
            if (fs.existsSync(dir)) {
                try {
                    const walkDir = (d: string) => {
                        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                            if (entry.isDirectory()) { walkDir(path.join(d, entry.name)); continue; }
                            if (!entry.name.endsWith('.js') && !entry.name.endsWith('.ts')) continue;
                            try {
                                const content = fs.readFileSync(path.join(d, entry.name), 'utf-8');
                                const matches = content.matchAll(/@CSBDDStepDef\(['"`](.+?)['"`]\)/g);
                                for (const match of matches) existingPatterns.add(match[1]);
                            } catch { /* skip */ }
                        }
                    };
                    walkDir(dir);
                } catch { /* skip */ }
            }
        }

        context.log('info', `Found ${existingPatterns.size} existing step patterns for duplicate detection`);

        // Classify steps
        const newSteps: typeof steps = [];
        const duplicateSteps: { pattern: string; reason: string }[] = [];
        const reusedSteps: { pattern: string; source: string }[] = [];

        for (const step of steps) {
            if (existingPatterns.has(step.pattern)) {
                reusedSteps.push({ pattern: step.pattern, source: 'existing' });
            } else {
                // Check for similar patterns (fuzzy)
                let foundSimilar = false;
                for (const existing of existingPatterns) {
                    // Normalize: remove {string}, {int}, quotes, extra spaces
                    const normalize = (s: string) => s.replace(/\{string\}|\{int\}|\{float\}/g, '{}').replace(/["']/g, '').trim().toLowerCase();
                    if (normalize(existing) === normalize(step.pattern)) {
                        duplicateSteps.push({ pattern: step.pattern, reason: `Similar to existing: "${existing}"` });
                        foundSimilar = true;
                        break;
                    }
                }
                if (!foundSimilar) {
                    newSteps.push(step);
                }
            }
        }

        // Generate step definitions for new steps only
        const stepDecls = newSteps.map(step => {
            const bodyCode = step.body.map(line => `        ${line}`).join('\n');
            return `
    @CSBDDStepDef('${escStr(step.pattern)}')
    async ${toCamelCase(step.pattern.replace(/[^a-zA-Z0-9\s]/g, '').trim().split(/\s+/).slice(0, 5).join('_'))}(${step.body.some(l => l.includes('param1')) ? 'param1: string' : ''}): Promise<void> {
${step.description ? `        CSReporter.info('${escStr(step.description)}');` : ''}
${bodyCode}
    }`;
        }).join('\n');

        // Build imports
        const imports: string[] = [
            `import { CSBDDStepDef, StepDefinitions } from '@cs-playwright/bdd';`,
            `import { CSScenarioContext } from '@cs-playwright/bdd';`,
            `import { CSReporter } from '@cs-playwright/reporting';`,
        ];

        // Add page imports
        const usedPages = new Set<string>();
        for (const step of newSteps) {
            if (step.pageRefs) step.pageRefs.forEach(p => usedPages.add(p));
        }

        for (const pi of pageImports) {
            if (usedPages.has(pi.className)) {
                imports.push(`import { ${pi.className} } from '${pi.importPath}';`);
            }
        }

        // Check if any step uses scenarioContext
        const usesContext = newSteps.some(s => s.scenarioContextVars &&
            ((s.scenarioContextVars.get && s.scenarioContextVars.get.length > 0) ||
             (s.scenarioContextVars.set && s.scenarioContextVars.set.length > 0)));

        // Page decorators
        const pageDecls = Array.from(usedPages).map(p => {
            const varName = toCamelCase(p.replace(/Page$/, '')) + 'Page';
            return `    @Page() private ${varName}!: ${p};`;
        }).join('\n');

        // Assemble
        const code = `${imports.join('\n')}

@StepDefinitions
export class ${className} {

${usesContext ? '    private scenarioContext = CSScenarioContext.getInstance();\n' : ''}${pageDecls ? pageDecls + '\n' : ''}
${stepDecls}
}
`;

        // Write file
        const outPath = path.resolve(outputDir, fileName);
        try {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, code, 'utf-8');
        } catch (err: any) {
            return errorResult(`Failed to write file: ${err.message}`);
        }

        return jsonResult({
            className,
            fileName,
            filePath: outPath,
            totalStepsReceived: steps.length,
            newStepsGenerated: newSteps.length,
            reusedFromExisting: reusedSteps.length,
            duplicatesSkipped: duplicateSteps.length,
            reusedSteps,
            duplicateSteps,
            code,
        });
    })
    .build();

// ============================================================================
// Tool 4: migrate_convert_data
// ============================================================================

const migrateConvertDataTool = defineTool()
    .name('migrate_convert_data')
    .description('Convert test data to CS Playwright JSON format. Accepts structured data (from Excel/CSV parsed by AI) and produces JSON files with scenarioId, runFlag, and proper field naming.')
    .category('generation')
    .stringParam('dataName', 'Data file name (e.g., "login_scenarios", "deal_series_data")', { required: true })
    .stringParam('project', 'Project name', { required: true })
    .arrayParam('rows', 'Array of data rows as objects: [{column1: value1, column2: value2, ...}]', 'object', { required: true })
    .arrayParam('columns', 'Column definitions: [{name, type, description}]', 'object')
    .stringParam('outputDir', 'Output directory (default: test/{project}/data)')
    .handler(async (params, context) => {
        const dataName = params.dataName as string;
        const project = params.project as string;
        const rows = params.rows as Array<Record<string, any>>;
        const outputDir = (params.outputDir as string) || `test/${project}/data`;

        context.log('info', `Converting ${rows.length} data rows for: ${dataName}`);

        // Add framework-required fields if missing
        const converted = rows.map((row, idx) => {
            const result: Record<string, any> = {};

            // Ensure required fields exist
            if (!row.scenarioId) result.scenarioId = `${dataName.toUpperCase().replace(/[^A-Z0-9]/g, '-')}-${String(idx + 1).padStart(2, '0')}`;
            else result.scenarioId = row.scenarioId;

            if (!row.scenarioName) result.scenarioName = `${toPascalCase(dataName)} - Row ${idx + 1}`;
            else result.scenarioName = row.scenarioName;

            if (!row.runFlag) result.runFlag = 'Yes';
            else result.runFlag = row.runFlag;

            // Copy all other fields with camelCase keys
            for (const [key, value] of Object.entries(row)) {
                if (key === 'scenarioId' || key === 'scenarioName' || key === 'runFlag') continue;
                const camelKey = toCamelCase(key.replace(/[^a-zA-Z0-9\s]/g, ' ').trim());
                result[camelKey] = value ?? '';
            }

            return result;
        });

        const fileName = `${toKebabCase(dataName)}.json`;
        const outPath = path.resolve(outputDir, fileName);

        try {
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, JSON.stringify(converted, null, 4), 'utf-8');
        } catch (err: any) {
            return errorResult(`Failed to write file: ${err.message}`);
        }

        return jsonResult({
            fileName,
            filePath: outPath,
            rowCount: converted.length,
            columns: Object.keys(converted[0] || {}),
            examplesRef: `Examples: {"type": "json", "source": "test/${project}/data/${fileName}", "path": "$", "filter": "runFlag=Yes"}`,
        });
    })
    .build();

// ============================================================================
// Tool 5: migrate_extract_queries
// ============================================================================

const migrateExtractQueriesTool = defineTool()
    .name('migrate_extract_queries')
    .description('Generate .env file with DB_QUERY_ prefixed SQL queries extracted by AI from Java source. Also generates a database helper class with static methods using CSDBUtils.')
    .category('generation')
    .stringParam('project', 'Project name', { required: true })
    .stringParam('dbAlias', 'Database alias (e.g., "APP_ORACLE", "APP_MSSQL")', { required: true })
    .arrayParam('queries', 'Array of query definitions: [{name, sql, params, description}]', 'object', { required: true })
    .stringParam('outputDir', 'Output directory for .env file (default: config/{project}/common)')
    .stringParam('helperOutputDir', 'Output directory for helper class (default: test/{project}/helpers)')
    .handler(async (params, context) => {
        const project = params.project as string;
        const dbAlias = params.dbAlias as string;
        const queries = params.queries as Array<{
            name: string;
            sql: string;
            params?: string[];
            description?: string;
            returnType?: string;
        }>;
        const outputDir = (params.outputDir as string) || `config/${project}/common`;
        const helperOutputDir = (params.helperOutputDir as string) || `test/${project}/helpers`;

        context.log('info', `Generating ${queries.length} DB queries for project: ${project}`);

        // Generate .env file
        const envLines: string[] = [
            `# ==============================================================================`,
            `# ${toPascalCase(project)} - Database Queries`,
            `# ==============================================================================`,
            `# All queries use DB_QUERY_ prefix for CSDBUtils resolution.`,
            `# ==============================================================================`,
            '',
        ];

        for (const q of queries) {
            if (q.description) envLines.push(`# ${q.description}`);
            if (q.params && q.params.length > 0) envLines.push(`# Params: ${q.params.join(', ')}`);
            const queryName = q.name.startsWith('DB_QUERY_') ? q.name : `DB_QUERY_${q.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
            envLines.push(`${queryName}=${q.sql}`);
            envLines.push('');
        }

        const envFileName = `${toKebabCase(project)}-db-queries.env`;
        const envPath = path.resolve(outputDir, envFileName);

        try {
            fs.mkdirSync(path.dirname(envPath), { recursive: true });
            fs.writeFileSync(envPath, envLines.join('\n'), 'utf-8');
        } catch (err: any) {
            return errorResult(`Failed to write .env file: ${err.message}`);
        }

        // Generate database helper class
        const helperClassName = `${toPascalCase(project)}DatabaseHelper`;
        const helperFileName = `${helperClassName}.ts`;

        const helperMethods = queries.map(q => {
            const methodName = toCamelCase(q.name.replace(/^(DB_QUERY_|GET_|VERIFY_|COUNT_|CHECK_)/i, ''));
            const queryAlias = q.name.replace(/^DB_QUERY_/i, '');
            const paramList = q.params ? q.params.map((p, i) => `${p}: string`).join(', ') : '';
            const paramArray = q.params ? `[${q.params.join(', ')}]` : '[]';

            return `
    /**${q.description ? `\n     * ${q.description}` : ''}
     * Query: ${queryAlias}
     */
    public static async ${methodName}(${paramList}): Promise<any> {
        const result = await CSDBUtils.executeQuery(this.DB_ALIAS, '${queryAlias}', ${paramArray});
        return result.rows && result.rows.length > 0 ? result.rows : null;
    }`;
        }).join('\n');

        const helperCode = `import { CSDBUtils } from '@cs-playwright/database-utils';
import { CSReporter } from '@cs-playwright/reporting';

export class ${helperClassName} {
    private static readonly DB_ALIAS = '${dbAlias}';
${helperMethods}
}
`;

        const helperPath = path.resolve(helperOutputDir, helperFileName);
        try {
            fs.mkdirSync(path.dirname(helperPath), { recursive: true });
            fs.writeFileSync(helperPath, helperCode, 'utf-8');
        } catch (err: any) {
            return errorResult(`Failed to write helper file: ${err.message}`);
        }

        return jsonResult({
            envFile: { fileName: envFileName, filePath: envPath, queryCount: queries.length },
            helperFile: { className: helperClassName, fileName: helperFileName, filePath: helperPath, methodCount: queries.length },
        });
    })
    .build();

// ============================================================================
// Tool 6: migrate_generate_config
// ============================================================================

const migrateGenerateConfigTool = defineTool()
    .name('migrate_generate_config')
    .description('Generate complete project configuration scaffold: global.env, common.env, environment-specific env files.')
    .category('generation')
    .stringParam('project', 'Project name', { required: true })
    .stringParam('baseUrl', 'Application base URL', { required: true })
    .stringParam('dbAlias', 'Database alias')
    .arrayParam('environments', 'Environment names (default: ["dev", "sit", "uat"])', 'string')
    .stringParam('outputDir', 'Output directory (default: config/{project})')
    .handler(async (params, context) => {
        const project = params.project as string;
        const baseUrl = params.baseUrl as string;
        const dbAlias = (params.dbAlias as string) || `${project.toUpperCase()}_ORACLE`;
        const environments = (params.environments as string[]) || ['dev', 'sit', 'uat'];
        const outputDir = (params.outputDir as string) || `config/${project}`;

        const files: { name: string; path: string }[] = [];

        // global.env
        const globalEnv = `# ==============================================================================
# CS TEST AUTOMATION FRAMEWORK - GLOBAL CONFIGURATION
# ==============================================================================

BROWSER=chrome
HEADLESS=false
TIMEOUT=30000
SLOW_MO=0
VIEWPORT_WIDTH=1920
VIEWPORT_HEIGHT=1080

SCREENSHOT_ON_FAILURE=true
VIDEO=off
HAR=never

STEP_DEFINITIONS_PATH=test/${project}/steps
PAGES_PATH=test/${project}/pages

REPORT_FORMAT=html,excel,pdf
`;

        const globalPath = path.resolve(outputDir, 'global.env');
        fs.mkdirSync(path.dirname(globalPath), { recursive: true });
        fs.writeFileSync(globalPath, globalEnv, 'utf-8');
        files.push({ name: 'global.env', path: globalPath });

        // common.env
        const commonEnv = `# ==============================================================================
# ${toPascalCase(project)} - Common Configuration
# ==============================================================================

DB_ALIAS=${dbAlias}
`;

        const commonDir = path.resolve(outputDir, 'common');
        fs.mkdirSync(commonDir, { recursive: true });
        fs.writeFileSync(path.join(commonDir, 'common.env'), commonEnv, 'utf-8');
        files.push({ name: 'common/common.env', path: path.join(commonDir, 'common.env') });

        // Environment-specific files
        const envDir = path.resolve(outputDir, 'environments');
        fs.mkdirSync(envDir, { recursive: true });

        for (const env of environments) {
            const envUrl = baseUrl.replace(/sit|dev|uat|prod/gi, env);
            const envContent = `# ==============================================================================
# ${toPascalCase(project)} - ${env.toUpperCase()} Environment
# ==============================================================================

TEST_BASE_URL=${envUrl}
ENVIRONMENT=${env}
`;
            const envPath = path.join(envDir, `${env}.env`);
            fs.writeFileSync(envPath, envContent, 'utf-8');
            files.push({ name: `environments/${env}.env`, path: envPath });
        }

        return jsonResult({
            project,
            filesGenerated: files.length,
            files,
        });
    })
    .build();

// ============================================================================
// Tool 7: migrate_validate_locators
// ============================================================================

const migrateValidateLocatorsTool = defineTool()
    .name('migrate_validate_locators')
    .description('Validate generated locators by reading a page object file and checking each element definition. Returns which locators are valid and suggests improvements. Use with Playwright MCP browser_snapshot for live validation.')
    .category('generation')
    .stringParam('pageFilePath', 'Path to the generated page object TypeScript file', { required: true })
    .handler(async (params, context) => {
        const pageFilePath = params.pageFilePath as string;

        if (!fs.existsSync(pageFilePath)) {
            return errorResult(`Page file not found: ${pageFilePath}`);
        }

        const content = fs.readFileSync(pageFilePath, 'utf-8');

        // Extract all @CSGetElement locators
        const elementRegex = /@CSGetElement\(\{([^}]+)\}\)/g;
        const elements: Array<{
            locator: string;
            locatorType: string;
            description: string;
            fieldName: string;
        }> = [];

        let match;
        while ((match = elementRegex.exec(content)) !== null) {
            const block = match[1];
            const locatorMatch = block.match(/(xpath|css|testId|text|role):\s*['"](.+?)['"]/);
            const descMatch = block.match(/description:\s*['"](.+?)['"]/);

            // Find the field name (next line after the decorator)
            const afterDecorator = content.slice(match.index + match[0].length);
            const fieldMatch = afterDecorator.match(/public\s+(\w+)/);

            if (locatorMatch) {
                elements.push({
                    locatorType: locatorMatch[1],
                    locator: locatorMatch[2],
                    description: descMatch ? descMatch[1] : 'unknown',
                    fieldName: fieldMatch ? fieldMatch[1] : 'unknown',
                });
            }
        }

        // Analyze locator quality
        const analysis = elements.map(el => {
            let quality: 'excellent' | 'good' | 'fair' | 'poor';
            let suggestion = '';

            if (el.locatorType === 'role' || el.locatorType === 'text') {
                quality = 'excellent';
            } else if (el.locatorType === 'testId') {
                quality = 'good';
            } else if (el.locatorType === 'css') {
                quality = el.locator.includes('#') || el.locator.includes('[data-') ? 'good' : 'fair';
                if (quality === 'fair') suggestion = 'Consider using role-based or text-based locator for better resilience';
            } else {
                quality = el.locator.includes('@id=') || el.locator.includes('@data-testid') ? 'fair' : 'poor';
                if (quality === 'poor') suggestion = 'XPath locators are brittle. Use Playwright MCP browser_generate_locator to get a better selector from the live app';
            }

            return { ...el, quality, suggestion };
        });

        const summary = {
            total: elements.length,
            excellent: analysis.filter(a => a.quality === 'excellent').length,
            good: analysis.filter(a => a.quality === 'good').length,
            fair: analysis.filter(a => a.quality === 'fair').length,
            poor: analysis.filter(a => a.quality === 'poor').length,
        };

        return jsonResult({
            pageFile: pageFilePath,
            summary,
            elements: analysis,
            instructions: summary.poor > 0 || summary.fair > 0
                ? 'Use Playwright MCP tools to improve locators: 1) browser_navigate to the page, 2) browser_snapshot to see the accessibility tree, 3) browser_generate_locator for each poor/fair element'
                : 'All locators look good. Proceed with testing.',
        });
    })
    .build();

// ============================================================================
// Tool 8: migrate_audit_code
// ============================================================================

const migrateAuditCodeTool = defineTool()
    .name('migrate_audit_code')
    .description('Audit all generated TypeScript files for syntax errors, import issues, rule violations, and cross-file consistency. Checks pages, steps, helpers, features, data files, and config. Returns a pass/fail report with fix instructions.')
    .category('generation')
    .stringParam('projectDir', 'Root project directory containing test/ and config/ folders', { required: true })
    .stringParam('project', 'Project name', { required: true })
    .handler(async (params, context) => {
        const projectDir = params.projectDir as string;
        const project = params.project as string;

        const testDir = path.resolve(projectDir, 'test', project);
        const configDir = path.resolve(projectDir, 'config', project);

        const violations: Array<{ file: string; line?: number; rule: string; severity: 'error' | 'warning'; message: string; fix?: string }> = [];
        const stats = { filesChecked: 0, passed: 0, errors: 0, warnings: 0 };

        // --- Helper: read file safely ---
        function readFile(filePath: string): string | null {
            try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
        }

        // --- Helper: find all files ---
        function findFiles(dir: string, ext: string): string[] {
            const results: string[] = [];
            if (!fs.existsSync(dir)) return results;
            function walk(d: string) {
                for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                    if (entry.isDirectory() && entry.name !== 'node_modules') walk(path.join(d, entry.name));
                    else if (entry.name.endsWith(ext)) results.push(path.join(d, entry.name));
                }
            }
            walk(dir);
            return results;
        }

        context.log('info', `Auditing generated code in: ${testDir}`);

        // =====================================================================
        // CHECK 1: Page object files
        // =====================================================================
        const pageFiles = findFiles(path.join(testDir, 'pages'), '.ts');
        for (const file of pageFiles) {
            stats.filesChecked++;
            const content = readFile(file)!;
            const rel = path.relative(projectDir, file);

            // Rule 1: correct imports (no barrel)
            if (content.includes("from '../'") || content.includes("from './'") || content.includes('/index')) {
                violations.push({ file: rel, rule: 'Rule 1', severity: 'error', message: 'Barrel or index import detected', fix: 'Use module-specific import paths' });
            }

            // Rule 2: CSReporter static
            if (content.includes('CSReporter.getInstance()')) {
                violations.push({ file: rel, rule: 'Rule 2', severity: 'error', message: 'CSReporter.getInstance() used — must be static', fix: 'Change to CSReporter.info(), CSReporter.pass(), etc.' });
            }

            // Rule 3: initializeElements
            if (content.includes('extends CSBasePage') && !content.includes('initializeElements')) {
                violations.push({ file: rel, rule: 'Rule 3', severity: 'error', message: 'Missing initializeElements() method', fix: 'Add: protected initializeElements(): void { CSReporter.debug("..."); }' });
            }

            // Rule 4: no redeclared inherited properties
            for (const prop of ['protected config', 'protected browserManager', 'protected page:', 'protected url:', 'protected elements']) {
                if (content.includes(prop)) {
                    violations.push({ file: rel, rule: 'Rule 4', severity: 'error', message: `Redeclared inherited property: ${prop.trim()}`, fix: 'Remove — inherited from CSBasePage' });
                }
            }

            // Rule 8: no raw Playwright APIs
            for (const raw of ['page.locator(', 'page.click(', 'page.fill(', 'page.goto(', 'page.waitForSelector(']) {
                if (content.includes(raw)) {
                    violations.push({ file: rel, rule: 'Rule 8', severity: 'error', message: `Raw Playwright API used: ${raw}`, fix: 'Use framework element methods instead' });
                }
            }

            // Syntax: unmatched braces
            const opens = (content.match(/\{/g) || []).length;
            const closes = (content.match(/\}/g) || []).length;
            if (opens !== closes) {
                violations.push({ file: rel, rule: 'Syntax', severity: 'error', message: `Unmatched braces: ${opens} open, ${closes} close`, fix: 'Check for missing or extra { or }' });
            }

            // Syntax: missing async/await
            const awaitMissing = content.match(/(?<!await\s)(this\.\w+\.(click|fill|clear|hover|selectOption|textContent|isVisible|waitForVisible)\()/g);
            if (awaitMissing && awaitMissing.length > 0) {
                violations.push({ file: rel, rule: 'Syntax', severity: 'warning', message: `${awaitMissing.length} element method call(s) possibly missing await`, fix: 'Ensure all async element methods are awaited' });
            }

            if (!violations.some(v => v.file === rel && v.severity === 'error')) stats.passed++;
        }

        // =====================================================================
        // CHECK 2: Step definition files
        // =====================================================================
        const stepFiles = findFiles(path.join(testDir, 'steps'), '.ts');
        for (const file of stepFiles) {
            stats.filesChecked++;
            const content = readFile(file)!;
            const rel = path.relative(projectDir, file);

            // Rule 5: no index.ts
            if (path.basename(file) === 'index.ts') {
                violations.push({ file: rel, rule: 'Rule 5', severity: 'error', message: 'Barrel file index.ts detected in steps', fix: 'Remove — each step file is standalone' });
            }

            // Rule 6: no element locators in steps
            if (content.includes('@CSGetElement') || content.includes('@CSGetElements')) {
                violations.push({ file: rel, rule: 'Rule 6', severity: 'error', message: 'Element locator (@CSGetElement) found in step file', fix: 'Move all locators to page object classes' });
            }

            // Rule 7: no hardcoded SQL
            const sqlPatterns = /(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\s+/i;
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (sqlPatterns.test(lines[i]) && !lines[i].trim().startsWith('//') && !lines[i].trim().startsWith('*')) {
                    violations.push({ file: rel, line: i + 1, rule: 'Rule 7', severity: 'error', message: `Hardcoded SQL detected: ${lines[i].trim().substring(0, 60)}...`, fix: 'Move query to .env file with DB_QUERY_ prefix, use CSDBUtils.executeQuery()' });
                }
            }

            // Rule 8: no raw Playwright APIs
            for (const raw of ['page.locator(', 'page.click(', 'page.fill(', 'page.goto(', 'page.waitForSelector(']) {
                if (content.includes(raw)) {
                    violations.push({ file: rel, rule: 'Rule 8', severity: 'error', message: `Raw Playwright API used: ${raw}`, fix: 'Use framework element methods or page object methods' });
                }
            }

            // Rule 12: duplicate step patterns within this file
            const stepPatterns = [...content.matchAll(/@CSBDDStepDef\(['"](.+?)['"]\)/g)].map(m => m[1]);
            const seen = new Set<string>();
            for (const pattern of stepPatterns) {
                if (seen.has(pattern)) {
                    violations.push({ file: rel, rule: 'Rule 13', severity: 'error', message: `Duplicate step pattern in same file: "${pattern}"`, fix: 'Remove the duplicate step definition' });
                }
                seen.add(pattern);
            }

            // Syntax: unmatched braces
            const opens = (content.match(/\{/g) || []).length;
            const closes = (content.match(/\}/g) || []).length;
            if (opens !== closes) {
                violations.push({ file: rel, rule: 'Syntax', severity: 'error', message: `Unmatched braces: ${opens} open, ${closes} close`, fix: 'Check for missing or extra { or }' });
            }

            if (!violations.some(v => v.file === rel && v.severity === 'error')) stats.passed++;
        }

        // =====================================================================
        // CHECK 3: Cross-file duplicate step detection
        // =====================================================================
        const allStepPatterns = new Map<string, string>(); // pattern → file
        for (const file of stepFiles) {
            const content = readFile(file)!;
            const rel = path.relative(projectDir, file);
            const patterns = [...content.matchAll(/@CSBDDStepDef\(['"](.+?)['"]\)/g)];
            for (const match of patterns) {
                const existing = allStepPatterns.get(match[1]);
                if (existing && existing !== rel) {
                    violations.push({ file: rel, rule: 'Rule 13', severity: 'error', message: `Step pattern "${match[1]}" also defined in ${existing}`, fix: 'Remove from one file — step definitions must be unique across all files' });
                }
                allStepPatterns.set(match[1], rel);
            }
        }

        // =====================================================================
        // CHECK 4: Feature files
        // =====================================================================
        const featureFiles = findFiles(path.join(testDir, 'features'), '.feature');
        for (const file of featureFiles) {
            stats.filesChecked++;
            const content = readFile(file)!;
            const rel = path.relative(projectDir, file);

            // Check Scenario Outline has Examples
            if (content.includes('Scenario Outline:') && !content.includes('Examples:')) {
                violations.push({ file: rel, rule: 'Feature', severity: 'error', message: 'Scenario Outline without Examples section', fix: 'Add Examples with JSON source reference' });
            }

            // Check for single-quoted params (should be double-quoted)
            const singleQuoted = content.match(/<'[^']+'>|'<[^>]+>'/g);
            if (singleQuoted) {
                violations.push({ file: rel, rule: 'Feature', severity: 'warning', message: `${singleQuoted.length} single-quoted parameter(s) — should use double quotes`, fix: 'Change \'<param>\' to "<param>"' });
            }

            // Check step text references exist in step files
            const stepLines = content.match(/(?:Given|When|Then|And|But)\s+(.+)/g) || [];
            // This is a light check — full validation would match against step patterns
            if (stepLines.length === 0 && content.includes('Scenario')) {
                violations.push({ file: rel, rule: 'Feature', severity: 'warning', message: 'Scenario with no step lines detected', fix: 'Add Given/When/Then steps' });
            }

            if (!violations.some(v => v.file === rel && v.severity === 'error')) stats.passed++;
        }

        // =====================================================================
        // CHECK 5: Data files
        // =====================================================================
        const dataFiles = findFiles(path.join(testDir, 'data'), '.json');
        for (const file of dataFiles) {
            stats.filesChecked++;
            const content = readFile(file);
            const rel = path.relative(projectDir, file);

            if (!content) {
                violations.push({ file: rel, rule: 'Data', severity: 'error', message: 'Cannot read data file', fix: 'Check file permissions and encoding' });
                continue;
            }

            try {
                const data = JSON.parse(content);
                if (!Array.isArray(data)) {
                    violations.push({ file: rel, rule: 'Data', severity: 'error', message: 'Data file is not a JSON array', fix: 'Wrap data in [ ]' });
                } else if (data.length > 0) {
                    // Check required fields
                    if (!data[0].scenarioId) {
                        violations.push({ file: rel, rule: 'Data', severity: 'warning', message: 'Missing scenarioId field in data rows', fix: 'Add scenarioId to each row' });
                    }
                    if (!data[0].runFlag) {
                        violations.push({ file: rel, rule: 'Data', severity: 'warning', message: 'Missing runFlag field in data rows', fix: 'Add runFlag: "Yes" to each row' });
                    }
                }
            } catch {
                violations.push({ file: rel, rule: 'Data', severity: 'error', message: 'Invalid JSON syntax', fix: 'Fix JSON formatting' });
            }

            if (!violations.some(v => v.file === rel && v.severity === 'error')) stats.passed++;
        }

        // =====================================================================
        // CHECK 6: Config files
        // =====================================================================
        const envDir = path.join(configDir, 'environments');
        if (!fs.existsSync(envDir)) {
            violations.push({ file: `config/${project}/environments/`, rule: 'Rule 9', severity: 'error', message: 'Missing environments/ subdirectory', fix: 'Create config/{project}/environments/ with dev.env, sit.env, uat.env' });
        }

        const queryEnvFiles = findFiles(path.join(configDir, 'common'), '.env');
        for (const file of queryEnvFiles) {
            stats.filesChecked++;
            const content = readFile(file)!;
            const rel = path.relative(projectDir, file);

            // Check DB_QUERY_ prefix
            const queryLines = content.split('\n').filter(l => l.includes('=') && !l.startsWith('#'));
            for (const line of queryLines) {
                const key = line.split('=')[0].trim();
                if (key.includes('SELECT') || key.includes('INSERT') || key.includes('UPDATE')) {
                    violations.push({ file: rel, rule: 'Config', severity: 'error', message: `Query key "${key}" looks like SQL — should use DB_QUERY_ prefix`, fix: 'Rename to DB_QUERY_{QUERY_NAME}=SQL...' });
                }
            }

            if (!violations.some(v => v.file === rel && v.severity === 'error')) stats.passed++;
        }

        // =====================================================================
        // CHECK 7: Helper files
        // =====================================================================
        const helperFiles = findFiles(path.join(testDir, 'helpers'), '.ts');
        for (const file of helperFiles) {
            stats.filesChecked++;
            const content = readFile(file)!;
            const rel = path.relative(projectDir, file);

            // Check hardcoded SQL in helpers
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/(?:SELECT|INSERT|UPDATE|DELETE)\s+/i.test(line) &&
                    !line.includes('DB_QUERY_') && !line.includes('executeQuery') &&
                    !line.trim().startsWith('//') && !line.trim().startsWith('*')) {
                    violations.push({ file: rel, line: i + 1, rule: 'Rule 7', severity: 'error', message: 'Hardcoded SQL in helper file', fix: 'Move to .env file, reference via CSDBUtils.executeQuery()' });
                }
            }

            if (!violations.some(v => v.file === rel && v.severity === 'error')) stats.passed++;
        }

        // =====================================================================
        // Summary
        // =====================================================================
        stats.errors = violations.filter(v => v.severity === 'error').length;
        stats.warnings = violations.filter(v => v.severity === 'warning').length;

        const passed = stats.errors === 0;

        return jsonResult({
            passed,
            summary: {
                filesChecked: stats.filesChecked,
                filesPassed: stats.passed,
                totalErrors: stats.errors,
                totalWarnings: stats.warnings,
                verdict: passed ? 'PASS — code is ready to run' : 'FAIL — fix errors before running',
            },
            violations: violations.sort((a, b) => {
                if (a.severity === 'error' && b.severity !== 'error') return -1;
                if (a.severity !== 'error' && b.severity === 'error') return 1;
                return a.file.localeCompare(b.file);
            }),
            instructions: passed
                ? 'All checks passed. Run: npx cs-playwright-test --project=' + project + ' --env=sit'
                : 'Fix all errors listed above, then call migrate_audit_code again to re-validate.',
        });
    })
    .build();

// ============================================================================
// Export all migration tools
// ============================================================================

export const migrationTools: MCPToolDefinition[] = [
    migrateScanFilesTool,
    migrateReadFileTool,
    migrateConvertPageTool,
    migrateConvertStepsTool,
    migrateConvertDataTool,
    migrateExtractQueriesTool,
    migrateGenerateConfigTool,
    migrateValidateLocatorsTool,
    migrateAuditCodeTool,
];

export function registerMigrationTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(migrationTools);
}
