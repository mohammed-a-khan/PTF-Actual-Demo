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

/**
 * Normalize file paths for cross-platform compatibility.
 *
 * Key problem: When Copilot sends a Windows path like Y:\test\file.java
 * via JSON, backslash sequences get interpreted as escape characters:
 *   \t → tab, \n → newline, \f → form feed, \r → carriage return, \b → backspace
 * This corrupts the path before it even reaches our code.
 *
 * Fix: Detect and repair corrupted escape sequences, then normalize separators.
 */
function normalizePath(inputPath: string): string {
    if (!inputPath) return inputPath;

    let normalized = inputPath;

    // 1. Repair JSON escape damage — replace control characters back to backslash + letter
    //    \t(tab=0x09) → \t, \n(lf=0x0A) → \n, \r(cr=0x0D) → \r, \f(ff=0x0C) → \f, \b(bs=0x08) → \b
    normalized = normalized
        .replace(/\t/g, '\\t')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\f/g, '\\f')
        .replace(/\x08/g, '\\b');

    // 2. Normalize all separators to OS-native
    normalized = normalized.replace(/[/\\]/g, path.sep);

    // 3. Uppercase drive letter on Windows (y: → Y:)
    if (/^[a-zA-Z]:/.test(normalized)) {
        normalized = normalized[0].toUpperCase() + normalized.slice(1);
    }

    // 4. Use path.normalize (NOT path.resolve — resolve changes relative to cwd which may differ)
    normalized = path.normalize(normalized);

    return normalized;
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
        const rawPath = params.sourcePath as string;
        const sourcePath = normalizePath(rawPath);

        context.log('info', `[migrate_scan_files] Raw input: "${rawPath}"`);
        context.log('info', `[migrate_scan_files] Normalized: "${sourcePath}"`);
        context.log('info', `[migrate_scan_files] platform: ${process.platform}, path.sep: "${path.sep}"`);

        // Try raw path as fallback
        let resolvedPath = sourcePath;
        if (!fs.existsSync(sourcePath)) {
            if (fs.existsSync(rawPath)) {
                context.log('info', `[migrate_scan_files] Raw path exists, using it`);
                resolvedPath = rawPath;
            } else {
                // Try alternatives
                const alts = [rawPath.replace(/\\/g, '/'), rawPath.replace(/\//g, '\\'), rawPath[0].toUpperCase() + rawPath.slice(1), rawPath[0].toLowerCase() + rawPath.slice(1)];
                const found = alts.find(a => fs.existsSync(a));
                if (found) {
                    context.log('info', `[migrate_scan_files] Found at alternative: "${found}"`);
                    resolvedPath = found;
                } else {
                    return errorResult(`Source path does not exist: ${sourcePath} (raw: "${rawPath}", platform: ${process.platform})`);
                }
            }
        }

        context.log('info', `Scanning source folder: ${resolvedPath}`);

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
                const rel = path.relative(resolvedPath, fullPath);
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

        scanDir(resolvedPath);

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
        const rawPath = params.filePath as string;
        const filePath = normalizePath(rawPath);

        context.log('info', `[migrate_read_file] Raw input path: "${rawPath}"`);
        context.log('info', `[migrate_read_file] Normalized path: "${filePath}"`);
        context.log('info', `[migrate_read_file] path.sep: "${path.sep}", process.platform: "${process.platform}"`);
        context.log('info', `[migrate_read_file] fs.existsSync result: ${fs.existsSync(filePath)}`);

        // Also try the raw path in case normalization is the problem
        if (!fs.existsSync(filePath) && fs.existsSync(rawPath)) {
            context.log('info', `[migrate_read_file] Raw path EXISTS but normalized does NOT — using raw path`);
            const stats = fs.statSync(rawPath);
            if (stats.size > 500000) {
                return errorResult(`File too large (${stats.size} bytes). Maximum is 500KB.`);
            }
            const content = fs.readFileSync(rawPath, 'utf-8');
            return jsonResult({ filePath: rawPath, size: stats.size, lines: content.split('\n').length, content });
        }

        if (!fs.existsSync(filePath)) {
            // Try common path transformations as fallback
            const alternatives = [
                rawPath,
                rawPath.replace(/\\/g, '/'),
                rawPath.replace(/\//g, '\\'),
                rawPath[0].toUpperCase() + rawPath.slice(1),
                rawPath[0].toLowerCase() + rawPath.slice(1),
            ];
            for (const alt of alternatives) {
                if (fs.existsSync(alt)) {
                    context.log('info', `[migrate_read_file] Found file at alternative path: "${alt}"`);
                    const stats = fs.statSync(alt);
                    if (stats.size > 500000) return errorResult(`File too large (${stats.size} bytes). Maximum is 500KB.`);
                    const content = fs.readFileSync(alt, 'utf-8');
                    return jsonResult({ filePath: alt, size: stats.size, lines: content.split('\n').length, content });
                }
            }
            return errorResult(`File does not exist: ${filePath} (raw input: "${rawPath}", platform: ${process.platform})`);
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
        const normalizedStepsDir = existingStepsDir ? normalizePath(existingStepsDir) : null;
        if (normalizedStepsDir && fs.existsSync(normalizedStepsDir)) {
            const files = fs.readdirSync(normalizedStepsDir).filter(f => f.endsWith('.steps.ts'));
            for (const file of files) {
                try {
                    const content = fs.readFileSync(path.join(normalizedStepsDir!, file), 'utf-8');
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
        const pageFilePath = normalizePath(params.pageFilePath as string);

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
        const projectDir = normalizePath(params.projectDir as string);
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
// Tool 10: migrate_detect_source_type
// ============================================================================

const migrateDetectSourceTypeTool = defineTool()
    .name('migrate_detect_source_type')
    .description('Detect whether a legacy source project uses TestNG or BDD (Cucumber/QAF) framework. Scans for .feature files, @Test annotations, @QAFTestStep, and framework-specific imports to determine the source type.')
    .category('migration')
    .stringParam('sourcePath', 'Path to the legacy source project root', { required: true })
    .handler(async (params, context) => {
        const sourcePath = normalizePath(params.sourcePath as string);

        if (!fs.existsSync(sourcePath)) {
            return errorResult(`Source path does not exist: ${sourcePath}`);
        }

        let featureCount = 0;
        let testAnnotationCount = 0;
        let qafStepCount = 0;
        let cucumberStepCount = 0;
        let javaFileCount = 0;
        const sampleFiles: { type: string; file: string }[] = [];

        function walk(dir: string): void {
            try {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory() && !['node_modules', '.git', 'target', 'build', 'dist'].includes(entry.name)) {
                        walk(fullPath);
                    } else if (entry.isFile()) {
                        if (entry.name.endsWith('.feature')) {
                            featureCount++;
                            if (sampleFiles.length < 5) sampleFiles.push({ type: 'feature', file: path.relative(sourcePath, fullPath) });
                        } else if (entry.name.endsWith('.java')) {
                            javaFileCount++;
                            try {
                                const content = fs.readFileSync(fullPath, 'utf-8');
                                if (/@Test\b/.test(content)) testAnnotationCount++;
                                if (/@QAFTestStep/.test(content)) qafStepCount++;
                                if (/@Given|@When|@Then|@And/.test(content)) cucumberStepCount++;
                            } catch { /* skip unreadable */ }
                        }
                    }
                }
            } catch { /* skip inaccessible dirs */ }
        }

        walk(sourcePath);

        // Determine source type
        let sourceType: 'testng' | 'bdd' | 'hybrid' | 'unknown';
        let confidence: number;
        let reasoning: string;

        if (featureCount > 0 && (qafStepCount > 0 || cucumberStepCount > 0)) {
            sourceType = 'bdd';
            confidence = 95;
            reasoning = `Found ${featureCount} .feature files and ${qafStepCount + cucumberStepCount} step definition files`;
        } else if (featureCount > 0 && testAnnotationCount > 0) {
            sourceType = 'hybrid';
            confidence = 80;
            reasoning = `Found both ${featureCount} .feature files and ${testAnnotationCount} @Test annotations — hybrid project`;
        } else if (testAnnotationCount > 0) {
            sourceType = 'testng';
            confidence = 95;
            reasoning = `Found ${testAnnotationCount} @Test annotations across ${javaFileCount} Java files, no .feature files`;
        } else {
            sourceType = 'unknown';
            confidence = 0;
            reasoning = `Could not detect framework: ${javaFileCount} Java files, ${featureCount} feature files`;
        }

        context.log('info', `Detected source type: ${sourceType} (${confidence}% confidence)`);

        return jsonResult({
            sourceType,
            confidence,
            reasoning,
            stats: { javaFiles: javaFileCount, featureFiles: featureCount, testAnnotations: testAnnotationCount, qafSteps: qafStepCount, cucumberSteps: cucumberStepCount },
            sampleFiles,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Tool 11: migrate_enumerate_tests
// ============================================================================

const migrateEnumerateTestsTool = defineTool()
    .name('migrate_enumerate_tests')
    .description('Enumerate every @Test method (TestNG) or Scenario (BDD) in the legacy source project. Returns a structured list with testCaseId, class name, method name, module assignment, and cross-module references. This is the foundation for coverage tracking — migration cannot be considered complete until every enumerated test has a matching migrated scenario.')
    .category('migration')
    .stringParam('sourcePath', 'Path to the legacy source project root', { required: true })
    .stringParam('sourceType', 'Source framework type (from migrate_detect_source_type)', { required: true, enum: ['testng', 'bdd'] })
    .handler(async (params, context) => {
        const sourcePath = normalizePath(params.sourcePath as string);
        const sourceType = params.sourceType as string;

        if (!fs.existsSync(sourcePath)) {
            return errorResult(`Source path does not exist: ${sourcePath}`);
        }

        const tests: Array<{
            testId: string;
            className: string;
            methodName: string;
            module: string;
            sourceFile: string;
            sourceType: string;
            crossModuleRefs: string[];
            status: string;
        }> = [];

        function walk(dir: string): string[] {
            const files: string[] = [];
            try {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory() && !['node_modules', '.git', 'target', 'build', 'dist'].includes(entry.name)) {
                        files.push(...walk(fullPath));
                    } else if (entry.isFile()) {
                        files.push(fullPath);
                    }
                }
            } catch { /* skip */ }
            return files;
        }

        const allFiles = walk(sourcePath);

        if (sourceType === 'testng') {
            // Scan Java files for @Test + @MetaData annotations
            const javaFiles = allFiles.filter(f => f.endsWith('.java'));

            for (const file of javaFiles) {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    if (!/@Test\b/.test(content)) continue;

                    const className = path.basename(file, '.java');
                    // Detect module from parent directory or class name patterns
                    const relPath = path.relative(sourcePath, file);
                    const module = relPath.split(path.sep)[0] || 'default';

                    // Extract @Test methods with testCaseId from @MetaData
                    const testBlocks = content.split(/@Test\b/);
                    for (let i = 1; i < testBlocks.length; i++) {
                        const block = testBlocks[i];
                        // Extract testCaseId from @MetaData annotation
                        const metaMatch = testBlocks[i - 1].match(/@MetaData[^)]*testCaseId\s*=\s*["']?(\d+)["']?/);
                        const testIdFromMeta = metaMatch ? metaMatch[1] : '';

                        // Extract method name
                        const methodMatch = block.match(/(?:public\s+)?void\s+(\w+)\s*\(/);
                        const methodName = methodMatch ? methodMatch[1] : `unknown_${i}`;

                        // Extract testCaseId from method body if not in @MetaData
                        let testId = testIdFromMeta;
                        if (!testId) {
                            const bodyIdMatch = block.match(/testCaseId\s*[=:]\s*["']?(\d+)["']?/);
                            testId = bodyIdMatch ? bodyIdMatch[1] : `${className}_${methodName}`;
                        }

                        // Detect cross-module references by looking for page object imports from other modules
                        const crossRefs: string[] = [];
                        const importMatches = content.matchAll(/import\s+[\w.]+\.(\w+)Page/g);
                        for (const im of importMatches) {
                            const pageModule = im[1].toLowerCase();
                            if (pageModule !== module.toLowerCase()) {
                                crossRefs.push(pageModule);
                            }
                        }

                        tests.push({
                            testId: `TS_${testId}`,
                            className,
                            methodName,
                            module,
                            sourceFile: relPath,
                            sourceType: 'testng',
                            crossModuleRefs: [...new Set(crossRefs)],
                            status: 'pending',
                        });
                    }
                } catch { /* skip unreadable */ }
            }
        } else if (sourceType === 'bdd') {
            // Scan .feature files for Scenarios
            const featureFiles = allFiles.filter(f => f.endsWith('.feature'));

            for (const file of featureFiles) {
                try {
                    const content = fs.readFileSync(file, 'utf-8');
                    const relPath = path.relative(sourcePath, file);
                    const module = relPath.split(path.sep)[0] || 'default';
                    const featureName = path.basename(file, '.feature');

                    // Extract testCaseId from @testCaseId tag
                    const scenarioBlocks = content.split(/Scenario(?:\s+Outline)?:/);
                    for (let i = 1; i < scenarioBlocks.length; i++) {
                        const block = scenarioBlocks[i];
                        const titleMatch = block.match(/^\s*(.+?)$/m);
                        const title = titleMatch ? titleMatch[1].trim() : `scenario_${i}`;

                        // Look for @testCaseId in the preceding block
                        const precBlock = scenarioBlocks[i - 1];
                        const tcIdMatch = precBlock.match(/@testCaseId[:\s]*(\S+)/);
                        const keyMatch = precBlock.match(/@key[:\s]*(\S+)/);
                        const testId = tcIdMatch ? tcIdMatch[1] : (keyMatch ? keyMatch[1] : `${featureName}_${i}`);

                        tests.push({
                            testId,
                            className: featureName,
                            methodName: title,
                            module,
                            sourceFile: relPath,
                            sourceType: 'bdd',
                            crossModuleRefs: [],
                            status: 'pending',
                        });
                    }
                } catch { /* skip */ }
            }
        }

        context.log('info', `Enumerated ${tests.length} tests across ${new Set(tests.map(t => t.module)).size} modules`);

        // Group by module for summary
        const byModule: Record<string, number> = {};
        for (const t of tests) {
            byModule[t.module] = (byModule[t.module] || 0) + 1;
        }

        return jsonResult({
            totalTests: tests.length,
            modules: byModule,
            crossModuleTests: tests.filter(t => t.crossModuleRefs.length > 0).length,
            tests,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Tool 12: migration_state_init
// ============================================================================

const migrationStateInitTool = defineTool()
    .name('migration_state_init')
    .description('Initialize a new migration state file (migration-state.json) in the target project directory. This file persists migration progress across sessions — tracking phases, modules, test coverage, quality gates, and step registries.')
    .category('migration')
    .stringParam('projectDir', 'Root directory of the target Playwright project', { required: true })
    .stringParam('projectName', 'Project name (used for folder structure)', { required: true })
    .stringParam('sourceType', 'Source framework type', { required: true, enum: ['testng', 'bdd'] })
    .stringParam('sourcePath', 'Absolute path to the legacy source project', { required: true })
    .arrayParam('modules', 'List of module names detected in the source project', 'string')
    .handler(async (params, context) => {
        const projectDir = normalizePath(params.projectDir as string);
        const stateFile = path.join(projectDir, 'migration-state.json');
        const modules = (params.modules as string[]) || [];

        const moduleMap: Record<string, any> = {};
        for (const mod of modules) {
            moduleMap[mod] = {
                status: 'pending',
                sourceFiles: [],
                totalTests: 0,
                migratedTests: 0,
                generatedPages: [],
                generatedSteps: [],
                generatedFeatures: [],
                generatedData: [],
                auditResults: [],
                healingAttempts: 0,
                humanReviewItems: [],
            };
        }

        const state = {
            projectName: params.projectName as string,
            sourceType: params.sourceType as string,
            sourcePath: normalizePath(params.sourcePath as string),
            targetPath: projectDir,
            startedAt: new Date().toISOString(),
            lastUpdatedAt: new Date().toISOString(),
            currentPhase: 0,
            currentModule: null,
            modules: moduleMap,
            coverage: {
                totalLegacyTests: 0,
                migratedTests: 0,
                skippedTests: [] as any[],
                humanReviewTests: [] as any[],
            },
            testEnumeration: [] as any[],
            qualityGates: [] as any[],
            stepRegistry: [] as any[],
        };

        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
        context.log('info', `Migration state initialized: ${stateFile}`);

        return jsonResult({
            stateFile,
            projectName: state.projectName,
            sourceType: state.sourceType,
            modulesCount: modules.length,
            modules,
        });
    })
    .build();

// ============================================================================
// Tool 11: migration_state_load
// ============================================================================

const migrationStateLoadTool = defineTool()
    .name('migration_state_load')
    .description('Load the current migration state from migration-state.json. Returns the full state including current phase, module status, coverage metrics, quality gate history, and step registry.')
    .category('migration')
    .stringParam('projectDir', 'Root directory of the target Playwright project', { required: true })
    .handler(async (params, context) => {
        const projectDir = normalizePath(params.projectDir as string);
        const stateFile = path.join(projectDir, 'migration-state.json');

        if (!fs.existsSync(stateFile)) {
            return errorResult(`Migration state not found at: ${stateFile}. Run migration_state_init first.`);
        }

        try {
            const content = fs.readFileSync(stateFile, 'utf-8');
            const state = JSON.parse(content);
            context.log('info', `Migration state loaded: phase ${state.currentPhase}, ${Object.keys(state.modules).length} modules`);
            return jsonResult(state);
        } catch (err: any) {
            return errorResult(`Failed to parse migration state: ${err.message}`);
        }
    })
    .readOnly()
    .build();

// ============================================================================
// Tool 12: migration_state_update
// ============================================================================

const migrationStateUpdateTool = defineTool()
    .name('migration_state_update')
    .description('Update a specific field in the migration state. Supports updating module status, current phase, coverage metrics, test enumeration entries, and adding generated file references.')
    .category('migration')
    .stringParam('projectDir', 'Root directory of the target Playwright project', { required: true })
    .stringParam('field', 'Top-level field to update', { required: true, enum: ['currentPhase', 'currentModule', 'moduleStatus', 'coverage', 'testEnumeration', 'addGeneratedFile', 'addStepPattern'] })
    .stringParam('module', 'Module name (required for moduleStatus and addGeneratedFile)')
    .stringParam('value', 'New value (JSON string for complex types, plain string for simple)')
    .handler(async (params, context) => {
        const projectDir = normalizePath(params.projectDir as string);
        const stateFile = path.join(projectDir, 'migration-state.json');

        if (!fs.existsSync(stateFile)) {
            return errorResult(`Migration state not found at: ${stateFile}`);
        }

        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        const field = params.field as string;
        const module = params.module as string;
        const rawValue = params.value as string;

        let parsedValue: any;
        try { parsedValue = JSON.parse(rawValue); } catch { parsedValue = rawValue; }

        state.lastUpdatedAt = new Date().toISOString();

        switch (field) {
            case 'currentPhase':
                state.currentPhase = Number(parsedValue);
                break;

            case 'currentModule':
                state.currentModule = parsedValue;
                break;

            case 'moduleStatus':
                if (!module || !state.modules[module]) {
                    return errorResult(`Module "${module}" not found in state`);
                }
                if (typeof parsedValue === 'string') {
                    state.modules[module].status = parsedValue;
                } else {
                    Object.assign(state.modules[module], parsedValue);
                }
                break;

            case 'coverage':
                Object.assign(state.coverage, parsedValue);
                break;

            case 'testEnumeration':
                if (Array.isArray(parsedValue)) {
                    state.testEnumeration.push(...parsedValue);
                } else {
                    state.testEnumeration.push(parsedValue);
                }
                // Update coverage totals
                state.coverage.totalLegacyTests = state.testEnumeration.length;
                state.coverage.migratedTests = state.testEnumeration.filter((t: any) => t.status === 'migrated').length;
                break;

            case 'addGeneratedFile':
                if (!module || !state.modules[module]) {
                    return errorResult(`Module "${module}" not found in state`);
                }
                const fileInfo = parsedValue as { type: string; path: string };
                const typeKey = `generated${toPascalCase(fileInfo.type)}s` as string;
                if (state.modules[module][typeKey]) {
                    state.modules[module][typeKey].push(fileInfo.path);
                }
                break;

            case 'addStepPattern':
                const stepEntry = parsedValue as { pattern: string; file: string; module: string };
                // Check for duplicates
                const exists = state.stepRegistry.some((s: any) => s.pattern === stepEntry.pattern);
                if (exists) {
                    return errorResult(`Duplicate step pattern: "${stepEntry.pattern}" — already registered`);
                }
                state.stepRegistry.push(stepEntry);
                break;

            default:
                return errorResult(`Unknown field: ${field}`);
        }

        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
        context.log('info', `Migration state updated: ${field}`);
        return jsonResult({ updated: field, module, timestamp: state.lastUpdatedAt });
    })
    .build();

// ============================================================================
// Tool 13: migration_state_get_next_task
// ============================================================================

const migrationStateGetNextTaskTool = defineTool()
    .name('migration_state_get_next_task')
    .description('Determine the next module and phase that needs work based on current migration state. Returns the highest-priority pending task with context.')
    .category('migration')
    .stringParam('projectDir', 'Root directory of the target Playwright project', { required: true })
    .handler(async (params, context) => {
        const projectDir = normalizePath(params.projectDir as string);
        const stateFile = path.join(projectDir, 'migration-state.json');

        if (!fs.existsSync(stateFile)) {
            return errorResult(`Migration state not found at: ${stateFile}`);
        }

        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        const phaseNames = ['init', 'source_analysis', 'page_generation', 'scenario_composition', 'config_data', 'full_audit', 'healing', 'complete'];

        // Find the first module that isn't complete
        for (const [modName, modState] of Object.entries(state.modules) as [string, any][]) {
            if (modState.status === 'complete') continue;

            // Determine which phase this module needs
            let nextPhase = state.currentPhase;
            let action = '';

            switch (modState.status) {
                case 'pending':
                    nextPhase = 1;
                    action = 'Run source analysis: extract tests, page objects, locators, and cross-module flows';
                    break;
                case 'analyzing':
                    nextPhase = 1;
                    action = 'Continue source analysis (in progress)';
                    break;
                case 'generating_pages':
                    nextPhase = 2;
                    action = 'Generate page objects from extracted manifest';
                    break;
                case 'composing_scenarios':
                    nextPhase = 3;
                    action = 'Compose scenarios from test enumeration';
                    break;
                case 'auditing':
                    nextPhase = 5;
                    action = 'Run full audit (framework rules, coverage, fidelity, density)';
                    break;
                case 'healing':
                    nextPhase = 6;
                    action = `Run healing iteration (attempt ${modState.healingAttempts + 1}/3)`;
                    break;
                case 'blocked':
                    action = `Module blocked — ${modState.humanReviewItems.length} items need human review`;
                    break;
            }

            return jsonResult({
                hasWork: true,
                module: modName,
                currentStatus: modState.status,
                nextPhase,
                phaseName: phaseNames[nextPhase] || 'unknown',
                action,
                totalTests: modState.totalTests,
                migratedTests: modState.migratedTests,
                healingAttempts: modState.healingAttempts,
                humanReviewItems: modState.humanReviewItems.length,
            });
        }

        // All modules complete
        return jsonResult({
            hasWork: false,
            message: 'All modules complete',
            coverage: state.coverage,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Tool 14: migration_state_record_gate
// ============================================================================

const migrationStateRecordGateTool = defineTool()
    .name('migration_state_record_gate')
    .description('Record a quality gate result (pass/fail/override) for a specific module and phase. Tracks gate history with timestamps for audit trail.')
    .category('migration')
    .stringParam('projectDir', 'Root directory of the target Playwright project', { required: true })
    .stringParam('gateId', 'Quality gate identifier (e.g., QG1, QG2, QG3, QG4, QG5, QG6)', { required: true })
    .stringParam('module', 'Module name', { required: true })
    .stringParam('status', 'Gate result', { required: true, enum: ['passed', 'failed', 'overridden'] })
    .stringParam('resultSummary', 'JSON summary of gate results (errors, warnings, coverage, etc.)')
    .stringParam('overrideReason', 'Reason for override (required when status=overridden)')
    .handler(async (params, context) => {
        const projectDir = normalizePath(params.projectDir as string);
        const stateFile = path.join(projectDir, 'migration-state.json');

        if (!fs.existsSync(stateFile)) {
            return errorResult(`Migration state not found at: ${stateFile}`);
        }

        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        const gateId = params.gateId as string;
        const module = params.module as string;
        const status = params.status as string;

        let resultData: any = {};
        if (params.resultSummary) {
            try { resultData = JSON.parse(params.resultSummary as string); } catch { resultData = { summary: params.resultSummary }; }
        }

        // Find or create gate record
        const existingIdx = state.qualityGates.findIndex((g: any) => g.gateId === gateId && g.module === module);
        const gateRecord = {
            gateId,
            module,
            status,
            attempts: existingIdx >= 0 ? state.qualityGates[existingIdx].attempts + 1 : 1,
            result: resultData,
            overrideReason: params.overrideReason || undefined,
            timestamp: new Date().toISOString(),
        };

        if (existingIdx >= 0) {
            state.qualityGates[existingIdx] = gateRecord;
        } else {
            state.qualityGates.push(gateRecord);
        }

        // Auto-advance module status on gate pass
        if (status === 'passed' || status === 'overridden') {
            const moduleState = state.modules[module];
            if (moduleState) {
                const statusAdvance: Record<string, string> = {
                    QG1: 'generating_pages',
                    QG2: 'composing_scenarios',
                    QG3: 'auditing',
                    QG4: 'auditing',
                    QG5: 'complete',
                    QG6: 'complete',
                };
                if (statusAdvance[gateId]) {
                    moduleState.status = statusAdvance[gateId];
                }
            }
        } else if (status === 'failed') {
            const moduleState = state.modules[module];
            if (moduleState && gateRecord.attempts >= 3) {
                moduleState.status = 'blocked';
            } else if (moduleState) {
                moduleState.status = 'healing';
            }
        }

        state.lastUpdatedAt = new Date().toISOString();
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
        context.log('info', `Quality gate ${gateId} for ${module}: ${status} (attempt ${gateRecord.attempts})`);

        return jsonResult(gateRecord);
    })
    .build();

// ============================================================================
// Tool 15: migration_step_registry_query
// ============================================================================

const migrationStepRegistryQueryTool = defineTool()
    .name('migration_step_registry_query')
    .description('Query the global step registry for existing step patterns. Use before generating new step definitions to prevent duplicates. Supports exact match and regex search.')
    .category('migration')
    .stringParam('projectDir', 'Root directory of the target Playwright project', { required: true })
    .stringParam('pattern', 'Step pattern to search for (exact or regex)', { required: true })
    .booleanParam('regex', 'Treat pattern as regex instead of exact match', { default: false })
    .handler(async (params, context) => {
        const projectDir = normalizePath(params.projectDir as string);
        const stateFile = path.join(projectDir, 'migration-state.json');

        if (!fs.existsSync(stateFile)) {
            return errorResult(`Migration state not found at: ${stateFile}`);
        }

        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        const searchPattern = params.pattern as string;
        const useRegex = params.regex as boolean;

        let matches: any[];
        if (useRegex) {
            const regex = new RegExp(searchPattern, 'i');
            matches = state.stepRegistry.filter((s: any) => regex.test(s.pattern));
        } else {
            // Normalize for comparison: remove {string}/{int}, lowercase, trim
            const normalize = (p: string) => p.replace(/\{[^}]+\}/g, '*').replace(/["']/g, '').toLowerCase().trim();
            const normalized = normalize(searchPattern);
            matches = state.stepRegistry.filter((s: any) => normalize(s.pattern) === normalized);
        }

        return jsonResult({
            query: searchPattern,
            matchCount: matches.length,
            matches,
            isDuplicate: matches.length > 0,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Tool 18: migrate_verify_locator_source
// ============================================================================

const migrateVerifyLocatorSourceTool = defineTool()
    .name('migrate_verify_locator_source')
    .description('Cross-check every @CSGetElement locator in a generated page object against a legacy page object manifest. Rejects any locator that cannot be traced back to the original @FindBy or QAF JSON source. Prevents fabricated/guessed locators.')
    .category('migration')
    .stringParam('generatedPagePath', 'Path to the generated TypeScript page object file', { required: true })
    .stringParam('legacyManifestPath', 'Path to the legacy page object manifest JSON (from source analyzer)', { required: true })
    .handler(async (params, context) => {
        const pagePath = normalizePath(params.generatedPagePath as string);
        const manifestPath = normalizePath(params.legacyManifestPath as string);

        if (!fs.existsSync(pagePath)) return errorResult(`Generated page not found: ${pagePath}`);
        if (!fs.existsSync(manifestPath)) return errorResult(`Legacy manifest not found: ${manifestPath}`);

        const pageContent = fs.readFileSync(pagePath, 'utf-8');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

        // Extract all @CSGetElement locators from generated file
        const generatedLocators: Array<{ name: string; locator: string; line: number }> = [];
        const lines = pageContent.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const xpathMatch = lines[i].match(/xpath:\s*["'`](.+?)["'`]/);
            const cssMatch = lines[i].match(/css:\s*["'`](.+?)["'`]/);
            const testIdMatch = lines[i].match(/testId:\s*["'`](.+?)["'`]/);
            const locator = xpathMatch?.[1] || cssMatch?.[1] || testIdMatch?.[1];
            if (locator) {
                // Find the property name (usually 1-3 lines below)
                const nameMatch = lines.slice(i, i + 5).join('\n').match(/public\s+(\w+)!?\s*:\s*CSWebElement/);
                generatedLocators.push({ name: nameMatch?.[1] || `element_line_${i + 1}`, locator, line: i + 1 });
            }
        }

        // Build set of legacy locator values for comparison
        const legacyLocators = new Set<string>();
        const legacyElements = manifest.elements || manifest;
        if (Array.isArray(legacyElements)) {
            for (const el of legacyElements) {
                const val = el.locatorValue || el.locator || el.xpath || el.css || '';
                if (val) legacyLocators.add(val.trim());
            }
        }

        // Cross-check each generated locator
        const verified: string[] = [];
        const unverified: Array<{ name: string; locator: string; line: number }> = [];

        for (const gen of generatedLocators) {
            // Check exact match or substring match (legacy may have xpath= prefix)
            const loc = gen.locator.trim();
            const found = legacyLocators.has(loc)
                || legacyLocators.has(`xpath=${loc}`)
                || legacyLocators.has(`css=${loc}`)
                || [...legacyLocators].some(l => l.includes(loc) || loc.includes(l));

            if (found) {
                verified.push(gen.name);
            } else {
                unverified.push(gen);
            }
        }

        const passed = unverified.length === 0;
        context.log('info', `Locator verification: ${verified.length}/${generatedLocators.length} verified, ${unverified.length} unverified`);

        return jsonResult({
            passed,
            totalLocators: generatedLocators.length,
            verified: verified.length,
            unverified: unverified.length,
            unverifiedLocators: unverified,
            message: passed
                ? 'All locators trace back to legacy source'
                : `${unverified.length} locator(s) cannot be traced to legacy source — may be fabricated`,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Tool 19: migrate_map_test_flow
// ============================================================================

const migrateMapTestFlowTool = defineTool()
    .name('migrate_map_test_flow')
    .description('Analyze a legacy Java @Test method body and produce a structured step-by-step flow mapping. Identifies which page objects are called, which methods, what assertions are made, and detects cross-module references. Used to enforce 1:1 scenario fidelity and prevent cross-module flow splitting.')
    .category('migration')
    .stringParam('filePath', 'Path to the legacy Java source file', { required: true })
    .stringParam('methodName', 'Name of the @Test method to analyze (optional — analyzes all if omitted)')
    .handler(async (params, context) => {
        const filePath = normalizePath(params.filePath as string);
        const targetMethod = params.methodName as string | undefined;

        if (!fs.existsSync(filePath)) return errorResult(`File not found: ${filePath}`);

        const content = fs.readFileSync(filePath, 'utf-8');
        const className = path.basename(filePath, '.java');

        // Extract page object references from imports
        const imports: Record<string, string> = {};
        const importMatches = content.matchAll(/import\s+([\w.]+)\.(\w+);/g);
        for (const m of importMatches) {
            imports[m[2]] = m[1];
        }

        // Identify page object fields
        const pageFields: Record<string, string> = {};
        const fieldMatches = content.matchAll(/(\w+(?:Page|Screen|Modal|Dialog))\s+(\w+)\s*[=;]/g);
        for (const m of fieldMatches) {
            pageFields[m[2]] = m[1];
        }

        // Extract method bodies
        const methods: Array<{
            methodName: string;
            testCaseId: string;
            steps: Array<{ pageObject: string; method: string; args: string; isAssertion: boolean }>;
            pageObjectsUsed: string[];
            crossModuleRefs: string[];
            isCrossModule: boolean;
        }> = [];

        // Split by @Test annotation to find method boundaries
        const testBlocks = content.split(/@Test\b/);
        for (let i = 1; i < testBlocks.length; i++) {
            const block = testBlocks[i];
            const methodMatch = block.match(/(?:public\s+)?void\s+(\w+)\s*\(/);
            if (!methodMatch) continue;
            const mName = methodMatch[1];

            if (targetMethod && mName !== targetMethod) continue;

            // Get testCaseId
            const metaMatch = testBlocks[i - 1].match(/testCaseId\s*=\s*["']?(\d+)["']?/);
            const testCaseId = metaMatch ? metaMatch[1] : '';

            // Parse method body for page object calls
            const steps: Array<{ pageObject: string; method: string; args: string; isAssertion: boolean }> = [];
            const pageObjectsUsed = new Set<string>();

            // Match patterns like: pageObj.methodName(args) or Assert.assertTrue(...)
            const callMatches = block.matchAll(/(\w+)\.(\w+)\s*\(([^)]*)\)/g);
            for (const cm of callMatches) {
                const obj = cm[1];
                const method = cm[2];
                const args = cm[3].trim();

                const isPage = pageFields[obj] || obj.endsWith('Page') || obj.endsWith('Screen');
                const isAssert = obj === 'Assert' || obj === 'Validator' || method.startsWith('verify') || method.startsWith('assert');

                if (isPage || isAssert) {
                    const poName = pageFields[obj] || obj;
                    steps.push({ pageObject: poName, method, args: args.substring(0, 100), isAssertion: isAssert });
                    if (isPage) pageObjectsUsed.add(poName);
                }
            }

            // Detect cross-module by checking if page objects come from different packages
            const modules = new Set<string>();
            for (const po of pageObjectsUsed) {
                const pkg = imports[po] || '';
                const modMatch = pkg.match(/\.(\w+)\.\w+$/);
                if (modMatch) modules.add(modMatch[1]);
            }

            methods.push({
                methodName: mName,
                testCaseId,
                steps,
                pageObjectsUsed: [...pageObjectsUsed],
                crossModuleRefs: [...modules],
                isCrossModule: modules.size > 1,
            });
        }

        context.log('info', `Mapped ${methods.length} test methods in ${className}`);

        return jsonResult({
            className,
            filePath: path.relative(process.cwd(), filePath),
            totalMethods: methods.length,
            crossModuleMethods: methods.filter(m => m.isCrossModule).length,
            methods,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Tool 20: migrate_check_step_density
// ============================================================================

const migrateCheckStepDensityTool = defineTool()
    .name('migrate_check_step_density')
    .description('Count verification steps (Then/And with assertions) per scenario in a generated feature file. Rejects scenarios with fewer than 3 verification steps as "thin" — these indicate incomplete migration where the legacy test had more checks.')
    .category('migration')
    .stringParam('featureFilePath', 'Path to the generated .feature file', { required: true })
    .numberParam('minVerificationSteps', 'Minimum verification steps per scenario (default: 3)', { default: 3 })
    .handler(async (params, context) => {
        const featurePath = normalizePath(params.featureFilePath as string);
        const minSteps = (params.minVerificationSteps as number) || 3;

        if (!fs.existsSync(featurePath)) return errorResult(`Feature file not found: ${featurePath}`);

        const content = fs.readFileSync(featurePath, 'utf-8');
        const lines = content.split('\n');

        const scenarios: Array<{ name: string; line: number; totalSteps: number; verificationSteps: number; isThin: boolean }> = [];
        let currentScenario: { name: string; line: number; totalSteps: number; verificationSteps: number } | null = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            if (/^Scenario( Outline)?:/.test(line)) {
                if (currentScenario) {
                    scenarios.push({ ...currentScenario, isThin: currentScenario.verificationSteps < minSteps });
                }
                currentScenario = { name: line.replace(/^Scenario( Outline)?:\s*/, ''), line: i + 1, totalSteps: 0, verificationSteps: 0 };
            } else if (currentScenario && /^(Given|When|Then|And|But)\s/.test(line)) {
                currentScenario.totalSteps++;
                // Verification steps: Then or And with assertion keywords
                if (/^Then\s/.test(line) || (/^And\s/.test(line) && /should|verify|assert|expect|visible|displayed|present|contain|match|equal|error|success|banner/i.test(line))) {
                    currentScenario.verificationSteps++;
                }
            }
        }
        if (currentScenario) {
            scenarios.push({ ...currentScenario, isThin: currentScenario.verificationSteps < minSteps });
        }

        const thinScenarios = scenarios.filter(s => s.isThin);
        const passed = thinScenarios.length === 0;

        context.log('info', `Density check: ${scenarios.length} scenarios, ${thinScenarios.length} thin`);

        return jsonResult({
            passed,
            featureFile: path.basename(featurePath),
            totalScenarios: scenarios.length,
            thinScenarios: thinScenarios.length,
            minVerificationSteps: minSteps,
            scenarios,
            message: passed
                ? 'All scenarios meet minimum verification step density'
                : `${thinScenarios.length} scenario(s) have fewer than ${minSteps} verification steps — likely incomplete migration`,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Tool 21: migrate_audit_coverage
// ============================================================================

const migrateAuditCoverageTool = defineTool()
    .name('migrate_audit_coverage')
    .description('Compare the test enumeration (from migrate_enumerate_tests) against all generated .feature files. Returns coverage percentage and lists every legacy testCaseId that has no matching migrated scenario. Migration cannot be complete until coverage = 100%.')
    .category('migration')
    .stringParam('projectDir', 'Root directory of the target Playwright project', { required: true })
    .stringParam('project', 'Project name (for test/ subfolder)', { required: true })
    .handler(async (params, context) => {
        const projectDir = normalizePath(params.projectDir as string);
        const project = params.project as string;
        const stateFile = path.join(projectDir, 'migration-state.json');

        if (!fs.existsSync(stateFile)) {
            return errorResult(`Migration state not found. Run migration_state_init first.`);
        }

        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        const enumeration = state.testEnumeration || [];

        if (enumeration.length === 0) {
            return errorResult(`No tests enumerated. Run migrate_enumerate_tests first.`);
        }

        // Scan all feature files for scenario names and test IDs
        const featuresDir = path.join(projectDir, 'test', project, 'features');
        const migratedIds = new Set<string>();

        function scanFeatures(dir: string): void {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) { scanFeatures(fullPath); continue; }
                if (!entry.name.endsWith('.feature')) continue;

                const content = fs.readFileSync(fullPath, 'utf-8');
                // Extract @TS_XXXX tags and scenario names containing test IDs
                const tagMatches = content.matchAll(/@(TS_\d+\w*)/g);
                for (const m of tagMatches) migratedIds.add(m[1]);

                const scenarioMatches = content.matchAll(/Scenario(?:\s+Outline)?:\s*(TS_\d+\w*)/g);
                for (const m of scenarioMatches) migratedIds.add(m[1]);
            }
        }

        scanFeatures(featuresDir);

        // Compare
        const missing: Array<{ testId: string; className: string; module: string }> = [];
        let migrated = 0;

        for (const test of enumeration) {
            if (migratedIds.has(test.testId)) {
                migrated++;
            } else {
                missing.push({ testId: test.testId, className: test.className, module: test.module });
            }
        }

        const total = enumeration.length;
        const percentage = total > 0 ? Math.round((migrated / total) * 100) : 0;
        const passed = missing.length === 0;

        // Group missing by module
        const missingByModule: Record<string, string[]> = {};
        for (const m of missing) {
            if (!missingByModule[m.module]) missingByModule[m.module] = [];
            missingByModule[m.module].push(m.testId);
        }

        context.log('info', `Coverage: ${migrated}/${total} (${percentage}%)`);

        return jsonResult({
            passed,
            coverage: { total, migrated, missing: missing.length, percentage },
            missingByModule,
            missingTests: missing,
            message: passed
                ? `100% coverage: all ${total} legacy tests have matching migrated scenarios`
                : `${percentage}% coverage: ${missing.length} legacy test(s) have no matching migrated scenario`,
        });
    })
    .readOnly()
    .build();

// ============================================================================
// Tool 22: migrate_audit_fidelity
// ============================================================================

const migrateAuditFidelityTool = defineTool()
    .name('migrate_audit_fidelity')
    .description('Compare generated scenario step count against legacy test method step count to detect over-migration (added steps not in legacy) and under-migration (missing steps from legacy). Uses the migration state test enumeration and flow mappings for comparison.')
    .category('migration')
    .stringParam('projectDir', 'Root directory of the target Playwright project', { required: true })
    .stringParam('project', 'Project name', { required: true })
    .stringParam('module', 'Module to audit (or "all" for all modules)', { required: true })
    .handler(async (params, context) => {
        const projectDir = normalizePath(params.projectDir as string);
        const project = params.project as string;
        const targetModule = params.module as string;

        // Scan feature files and count steps per scenario
        const featuresDir = path.join(projectDir, 'test', project, 'features');
        const scenarioStepCounts: Record<string, { steps: number; verifications: number; file: string }> = {};

        function scanFeatures(dir: string): void {
            if (!fs.existsSync(dir)) return;
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (targetModule === 'all' || entry.name === targetModule) scanFeatures(fullPath);
                    continue;
                }
                if (!entry.name.endsWith('.feature')) continue;

                const content = fs.readFileSync(fullPath, 'utf-8');
                const lines = content.split('\n');
                let currentId = '';
                let stepCount = 0;
                let verifyCount = 0;

                for (const line of lines) {
                    const trimmed = line.trim();
                    const scenarioMatch = trimmed.match(/Scenario(?:\s+Outline)?:\s*(TS_\d+\w*)/);
                    if (scenarioMatch) {
                        if (currentId) {
                            scenarioStepCounts[currentId] = { steps: stepCount, verifications: verifyCount, file: entry.name };
                        }
                        currentId = scenarioMatch[1];
                        stepCount = 0;
                        verifyCount = 0;
                    } else if (/^(Given|When|Then|And|But)\s/.test(trimmed)) {
                        stepCount++;
                        if (/^(Then|And)\s/.test(trimmed) && /should|verify|assert|visible|error|success/i.test(trimmed)) {
                            verifyCount++;
                        }
                    }
                }
                if (currentId) {
                    scenarioStepCounts[currentId] = { steps: stepCount, verifications: verifyCount, file: entry.name };
                }
            }
        }

        scanFeatures(featuresDir);

        // Compare with expected step counts (from state if available)
        const stateFile = path.join(projectDir, 'migration-state.json');
        let expectedCounts: Record<string, number> = {};
        if (fs.existsSync(stateFile)) {
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            for (const test of state.testEnumeration || []) {
                if (test.expectedSteps) {
                    expectedCounts[test.testId] = test.expectedSteps;
                }
            }
        }

        const results: Array<{
            testId: string;
            generatedSteps: number;
            generatedVerifications: number;
            expectedSteps: number | null;
            fidelity: 'matched' | 'over' | 'under' | 'unknown';
            file: string;
        }> = [];

        for (const [testId, counts] of Object.entries(scenarioStepCounts)) {
            const expected = expectedCounts[testId] || null;
            let fidelity: 'matched' | 'over' | 'under' | 'unknown' = 'unknown';
            if (expected !== null) {
                if (counts.steps === expected) fidelity = 'matched';
                else if (counts.steps > expected * 1.3) fidelity = 'over';
                else if (counts.steps < expected * 0.7) fidelity = 'under';
                else fidelity = 'matched';
            }

            results.push({
                testId,
                generatedSteps: counts.steps,
                generatedVerifications: counts.verifications,
                expectedSteps: expected,
                fidelity,
                file: counts.file,
            });
        }

        const overMigrated = results.filter(r => r.fidelity === 'over');
        const underMigrated = results.filter(r => r.fidelity === 'under');

        context.log('info', `Fidelity audit: ${results.length} scenarios, ${overMigrated.length} over, ${underMigrated.length} under`);

        return jsonResult({
            totalScenarios: results.length,
            matched: results.filter(r => r.fidelity === 'matched').length,
            overMigrated: overMigrated.length,
            underMigrated: underMigrated.length,
            unknown: results.filter(r => r.fidelity === 'unknown').length,
            overMigratedScenarios: overMigrated,
            underMigratedScenarios: underMigrated,
            results,
        });
    })
    .readOnly()
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
    migrateDetectSourceTypeTool,
    migrateEnumerateTestsTool,
    migrateVerifyLocatorSourceTool,
    migrateMapTestFlowTool,
    migrateCheckStepDensityTool,
    migrateAuditCoverageTool,
    migrateAuditFidelityTool,
    migrationStateInitTool,
    migrationStateLoadTool,
    migrationStateUpdateTool,
    migrationStateGetNextTaskTool,
    migrationStateRecordGateTool,
    migrationStepRegistryQueryTool,
];

export function registerMigrationTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(migrationTools);
}
