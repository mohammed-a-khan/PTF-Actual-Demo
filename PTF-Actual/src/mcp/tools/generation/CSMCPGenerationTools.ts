/**
 * CS Playwright MCP Generation Tools
 * Generate framework-compliant code using PTF-ADO patterns
 *
 * Generates code following the PTF-ADO framework patterns:
 * - Page Objects with @CSPage and @CSGetElement decorators
 * - Step Definitions with @StepDefinitions and @CSBDDStepDef
 * - Feature files with data source integration
 * - Spec tests with describe/it format
 *
 * @module CSMCPGenerationTools
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    MCPToolDefinition,
    MCPToolResult,
    MCPTextContent,
} from '../../types/CSMCPTypes';
import { defineTool, CSMCPToolRegistry } from '../../CSMCPToolRegistry';
import { CSReporter } from '../../../reporter/CSReporter';

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

function toPascalCase(str: string): string {
    return str
        .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
        .replace(/^(.)/, (_, c) => c.toUpperCase());
}

function toCamelCase(str: string): string {
    const pascal = toPascalCase(str);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function toKebabCase(str: string): string {
    return str
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/[\s_]+/g, '-')
        .toLowerCase();
}

/**
 * Escape a string for use inside double-quoted TypeScript strings.
 * XPath locators commonly contain single quotes, so we use double quotes for locator values.
 */
function escapeForDoubleQuote(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Escape a string for use inside single-quoted TypeScript strings.
 */
function escapeForSingleQuote(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ============================================================================
// Page Object Generation Tools
// ============================================================================

const generatePageObjectTool = defineTool()
    .name('generate_page_object')
    .description('Generate a Page Object class following PTF-ADO patterns with @CSPage and @CSGetElement decorators')
    .category('generation')
    .stringParam('pageName', 'Page name (e.g., "Login", "Dashboard", "DealDetails")', { required: true })
    .stringParam('projectPrefix', 'Project prefix (e.g., "MyApp", "App")', { required: true })
    .arrayParam('elements', 'Element definitions array', 'object', { required: true })
    .stringParam('pageUrl', 'Page URL path')
    .stringParam('outputPath', 'Output file path')
    .handler(async (params, context) => {
        const pageName = params.pageName as string;
        const projectPrefix = params.projectPrefix as string;
        const elements = params.elements as Array<{
            name: string;
            locator: string;
            locatorType?: 'xpath' | 'css' | 'testId' | 'text' | 'role';
            description?: string;
            waitForVisible?: boolean;
            waitForEnabled?: boolean;
            selfHeal?: boolean;
            alternativeLocators?: string[];
            isMultiple?: boolean;
        }>;
        const pageUrl = params.pageUrl as string | undefined;
        const outputPath = params.outputPath as string | undefined;

        // Strip trailing "Page" from pageName to avoid double suffix, PascalCase the prefix
        const cleanPageName = pageName.replace(/Page$/i, '');
        const className = `${toPascalCase(projectPrefix)}${toPascalCase(cleanPageName)}Page`;
        const pageId = `${toKebabCase(projectPrefix)}-${toKebabCase(cleanPageName)}`;
        const fileName = `${className}.ts`;

        context.log('info', `Generating page object: ${className}`);

        // Generate element declarations
        const elementDeclarations = elements.map(el => {
            const decoratorName = el.isMultiple ? '@CSGetElements' : '@CSGetElement';
            const locatorKey = el.locatorType || 'xpath';
            const options: string[] = [`${locatorKey}: "${escapeForDoubleQuote(el.locator)}"`];

            if (el.description) options.push(`description: '${escapeForSingleQuote(el.description)}'`);
            if (el.waitForVisible) options.push('waitForVisible: true');
            if (el.waitForEnabled) options.push('waitForEnabled: true');
            if (el.selfHeal) options.push('selfHeal: true');
            if (el.alternativeLocators?.length) {
                options.push(`alternativeLocators: [${el.alternativeLocators.map(l => `"${escapeForDoubleQuote(l)}"`).join(', ')}]`);
            }

            const elementType = el.isMultiple ? 'CSWebElement[]' : 'CSWebElement';

            return `    ${decoratorName}({
        ${options.join(',\n        ')}
    })
    public ${toCamelCase(el.name)}!: ${elementType};`;
        }).join('\n\n');

        // Generate action methods
        const actionMethods = elements
            .filter(el => !el.isMultiple)
            .map(el => {
                const methodName = toCamelCase(el.name);
                const pascalName = toPascalCase(el.name);
                const desc = escapeForSingleQuote(el.description || el.name);

                // Determine element type from locator or name
                const isButton = /button|btn|submit|click/i.test(el.name) || /button/i.test(el.locator);
                const isInput = /input|field|text|search/i.test(el.name) || /input|textarea/i.test(el.locator);
                const isDropdown = /dropdown|select|combo/i.test(el.name) || /select/i.test(el.locator);
                const isCheckbox = /checkbox|check/i.test(el.name) || /checkbox/i.test(el.locator);

                const methods: string[] = [];

                if (isButton) {
                    methods.push(`    /**
     * Click ${desc}
     */
    async click${pascalName}(): Promise<void> {
        CSReporter.info('Clicking ${desc}');
        await this.${methodName}.click();
        CSReporter.pass('Clicked ${desc}');
    }`);
                }

                if (isInput) {
                    methods.push(`    /**
     * Fill ${desc} with value
     */
    async fill${pascalName}(value: string): Promise<void> {
        CSReporter.info(\`Filling ${desc} with: \${value}\`);
        await this.${methodName}.fill(value);
        CSReporter.pass('Filled ${desc}');
    }

    /**
     * Get value from ${desc}
     */
    async get${pascalName}Value(): Promise<string> {
        return await this.${methodName}.inputValue();
    }

    /**
     * Clear ${desc}
     */
    async clear${pascalName}(): Promise<void> {
        await this.${methodName}.fill('');
    }`);
                }

                if (isDropdown) {
                    methods.push(`    /**
     * Select option in ${desc}
     */
    async select${pascalName}(value: string): Promise<void> {
        CSReporter.info(\`Selecting '\${value}' in ${desc}\`);
        await this.${methodName}.selectOption(value);
        CSReporter.pass(\`Selected '\${value}' in ${desc}\`);
    }`);
                }

                if (isCheckbox) {
                    methods.push(`    /**
     * Check/Uncheck ${desc}
     */
    async set${pascalName}Checked(checked: boolean): Promise<void> {
        if (checked) {
            await this.${methodName}.check();
        } else {
            await this.${methodName}.uncheck();
        }
    }

    /**
     * Get checked state of ${desc}
     */
    async is${pascalName}Checked(): Promise<boolean> {
        return await this.${methodName}.isChecked();
    }`);
                }

                // Always add visibility check
                methods.push(`    /**
     * Verify ${desc} is visible
     */
    async verify${pascalName}IsVisible(): Promise<void> {
        const isVisible = await this.${methodName}.isVisible();
        if (!isVisible) {
            throw new Error('${desc} is not visible');
        }
        CSReporter.pass('${desc} is visible');
    }`);

                return methods.join('\n\n');
            })
            .join('\n\n');

        // Generate the full page object code
        const code = `/**
 * ${className}
 * Page Object for ${pageName} page
 *
 * @module ${className}
 * @generated ${new Date().toISOString()}
 */

import { CSPage, CSGetElement, CSGetElements, CSBasePage } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';

@CSPage('${pageId}')
export class ${className} extends CSBasePage {
    // ========================================================================
    // Element Locators
    // ========================================================================

${elementDeclarations}

    // ========================================================================
    // Page Lifecycle
    // ========================================================================

    protected initializeElements(): void {
        // Elements are auto-initialized via decorators
    }

    /**
     * Navigate to this page
     */
    async navigate(): Promise<void> {
        ${pageUrl ? `await super.navigate('${escapeForSingleQuote(pageUrl)}');` : '// Define navigation URL in config or override this method'}
        await this.waitForPageLoad();
    }

    /**
     * Wait for page to fully load
     */
    async waitForPageLoad(): Promise<void> {
        // Wait for key element to be visible
        ${elements[0] ? `await this.${toCamelCase(elements[0].name)}.waitForVisible();` : '// Add wait condition for page load'}
    }

    /**
     * Verify page is displayed
     */
    async verifyPageDisplayed(): Promise<void> {
        CSReporter.info('Verifying ${pageName} page is displayed');
        await this.waitForPageLoad();
        CSReporter.pass('${pageName} page is displayed');
    }

    // ========================================================================
    // Page Actions
    // ========================================================================

${actionMethods}
}
`;

        // Write file if output path provided
        if (outputPath) {
            const fullPath = outputPath.endsWith('.ts') ? outputPath : path.join(outputPath, fileName);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(fullPath, code);
            CSReporter.pass(`Generated page object: ${fullPath}`);
        }

        return createJsonResult({
            success: true,
            className,
            fileName,
            pageId,
            elementCount: elements.length,
            code,
            outputPath: outputPath || null,
        });
    })
    .build();

// ============================================================================
// Step Definition Generation Tools
// ============================================================================

const generateStepDefinitionsTool = defineTool()
    .name('generate_step_definitions')
    .description('Generate step definitions class following PTF-ADO patterns with @StepDefinitions and @CSBDDStepDef decorators')
    .category('generation')
    .stringParam('className', 'Step definitions class name', { required: true })
    .stringParam('projectPrefix', 'Project prefix (e.g., "myapp")', { required: true })
    .arrayParam('pageObjects', 'Page objects to inject', 'string', { required: true })
    .arrayParam('steps', 'Step definitions', 'object', { required: true })
    .stringParam('outputPath', 'Output file path')
    .handler(async (params, context) => {
        const className = params.className as string;
        const projectPrefix = params.projectPrefix as string;
        const pageObjects = params.pageObjects as string[];
        const steps = params.steps as Array<{
            pattern: string;
            description?: string;
            parameters?: Array<{ name: string; type: string }>;
            implementation?: string;
        }>;
        const outputPath = params.outputPath as string | undefined;

        context.log('info', `Generating step definitions: ${className}`);

        const fileName = `${className}.ts`;

        // Generate page object imports and injections
        const pageImports = pageObjects.map(po => {
            const pageClass = po.includes('Page') ? po : `${projectPrefix}${toPascalCase(po)}Page`;
            return `import { ${pageClass} } from '../pages/${pageClass}';`;
        }).join('\n');

        const pageInjections = pageObjects.map(po => {
            const pageClass = po.includes('Page') ? po : `${projectPrefix}${toPascalCase(po)}Page`;
            const pageId = toKebabCase(pageClass.replace(/Page$/, ''));
            const propName = toCamelCase(po.replace(/Page$/, '')) + 'Page';
            return `    @Page('${pageId}')
    private ${propName}!: ${pageClass};`;
        }).join('\n\n');

        // Build property name mapping for implementation auto-correction
        // Maps short names (e.g., "loginPage") to full names (e.g., "orangehrmLoginPage")
        const propertyNameMap: Record<string, string> = {};
        const prefixPascal = toPascalCase(projectPrefix);
        pageObjects.forEach(po => {
            const pageClass = po.includes('Page') ? po : `${projectPrefix}${toPascalCase(po)}Page`;
            const fullPropName = toCamelCase(po.replace(/Page$/, '')) + 'Page';
            // If class has a prefix, map the short form to the full form
            if (pageClass.startsWith(prefixPascal) && pageClass.length > prefixPascal.length + 4) {
                const shortClass = pageClass.substring(prefixPascal.length);
                const shortPropName = toCamelCase(shortClass.replace(/Page$/, '')) + 'Page';
                if (shortPropName !== fullPropName) {
                    propertyNameMap[shortPropName] = fullPropName;
                }
            }
        });

        // Generate step definitions with safe implementation
        const stepDefinitions = steps.map(step => {
            const params = step.parameters ? [...step.parameters] : [];

            // Auto-extract parameters from {string}/{int} in pattern if not provided
            if (!params.length) {
                const paramRegex = /(\w+)\s+\{(\w+)\}/g;
                let paramMatch;
                const usedNames = new Set<string>();
                while ((paramMatch = paramRegex.exec(step.pattern)) !== null) {
                    let pName = toCamelCase(paramMatch[1]);
                    const rawType = paramMatch[2];
                    const pType = (rawType === 'int' || rawType === 'float') ? 'number' : 'string';
                    if (usedNames.has(pName)) { pName = `${pName}${usedNames.size + 1}`; }
                    usedNames.add(pName);
                    params.push({ name: pName, type: pType });
                }
            }

            const paramList = params.map(p => `${p.name}: ${p.type}`).join(', ');
            const methodName = step.pattern
                .replace(/\{[^}]+\}/g, '') // Remove {string}, {int} placeholders
                .replace(/[^a-zA-Z0-9\s]/g, '')
                .trim()
                .split(/\s+/)
                .filter(w => w.length > 0)
                .map((w, i) => i === 0 ? w.toLowerCase() : toPascalCase(w))
                .join('');

            // Build safe implementation - never reference this.browserManager or this.config
            let impl = step.implementation;
            if (!impl || impl === 'undefined' || impl.trim() === '') {
                impl = '// TODO: Implement using page object methods\n        // Available: page objects via this.<pageName>, this.context, this.scenarioContext, CSReporter';
            }

            // Auto-correct short property name references to full prefixed names
            // e.g., this.loginPage → this.orangehrmLoginPage
            for (const [shortName, fullName] of Object.entries(propertyNameMap)) {
                impl = impl.replace(new RegExp(`this\\.${shortName}\\b`, 'g'), `this.${fullName}`);
            }

            // Remove references to this.browserManager and this.config (they don't exist on step class)
            impl = impl.replace(/this\.browserManager\b[^;]*/g, '// browserManager not available in steps — use page object methods');
            impl = impl.replace(/this\.config\b[^;]*/g, '// config not available in steps — use CSValueResolver.resolve()');

            const escapedPattern = escapeForSingleQuote(step.pattern);
            const escapedDesc = escapeForSingleQuote(step.description || step.pattern);

            return `    /**
     * ${step.description || step.pattern}
     */
    @CSBDDStepDef('${escapedPattern}')
    async ${methodName}(${paramList}): Promise<void> {
        CSReporter.info('${escapedDesc}');
        ${impl}
        CSReporter.pass('Step completed');
    }`;
        }).join('\n\n');

        // Detect if any step implementation uses CSAssert
        const needsCSAssert = steps.some(s => s.implementation && s.implementation.includes('CSAssert'));
        const assertImport = needsCSAssert
            ? "import { CSAssert } from '@mdakhan.mak/cs-playwright-test-framework/assertions';\n"
            : '';

        const code = `/**
 * ${className}
 * Step definitions for ${projectPrefix} tests
 *
 * @module ${className}
 * @generated ${new Date().toISOString()}
 */

import {
    StepDefinitions,
    Page,
    CSBDDStepDef,
    CSBDDContext,
    CSScenarioContext
} from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';
import { CSValueResolver } from '@mdakhan.mak/cs-playwright-test-framework/utilities';
${assertImport}
${pageImports}

@StepDefinitions
export class ${className} {
    // ========================================================================
    // Page Object Injections
    // ========================================================================

${pageInjections}

    // ========================================================================
    // Context
    // ========================================================================

    private context = CSBDDContext.getInstance();
    private scenarioContext = CSScenarioContext.getInstance();

    // ========================================================================
    // Step Definitions
    // ========================================================================

${stepDefinitions}

    // ========================================================================
    // Helper Methods
    // ========================================================================

    /**
     * Resolve variable from context
     */
    private resolve(value: string): string {
        return CSValueResolver.resolve(value, this.context);
    }

    /**
     * Store value in scenario context
     */
    private storeInContext(key: string, value: unknown): void {
        this.scenarioContext.set(key, value);
    }

    /**
     * Get value from scenario context
     */
    private getFromContext(key: string): unknown {
        return this.scenarioContext.get(key);
    }
}
`;

        // Write file if output path provided
        if (outputPath) {
            const fullPath = outputPath.endsWith('.ts') ? outputPath : path.join(outputPath, fileName);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(fullPath, code);
            CSReporter.pass(`Generated step definitions: ${fullPath}`);
        }

        return createJsonResult({
            success: true,
            className,
            fileName,
            stepCount: steps.length,
            pageObjectCount: pageObjects.length,
            pagePropertyNames: pageObjects.map(po => {
                return toCamelCase(po.replace(/Page$/, '')) + 'Page';
            }),
            propertyNameCorrections: Object.keys(propertyNameMap).length > 0 ? propertyNameMap : undefined,
            code,
            outputPath: outputPath || null,
        });
    })
    .build();

// ============================================================================
// Feature File Generation Tools
// ============================================================================

const generateFeatureFileTool = defineTool()
    .name('generate_feature_file')
    .description('Generate a Gherkin feature file following PTF-ADO patterns with Background, comments, and JSON data source integration')
    .category('generation')
    .stringParam('featureName', 'Feature name', { required: true })
    .stringParam('description', 'Feature description (supports multi-line: "As a user\\nI want to...\\nSo that...")', { required: true })
    .arrayParam('tags', 'Feature-level tags', 'string')
    .arrayParam('background', 'Background steps (run before every scenario)', 'object')
    .arrayParam('scenarios', 'Scenario definitions', 'object', { required: true })
    .stringParam('dataSourcePath', 'Default data source path for Scenario Outlines (can be overridden per scenario)')
    .stringParam('dataSourceFilter', 'Default filter expression (default: "runFlag=Yes")')
    .stringParam('outputPath', 'Output file path')
    .handler(async (params, context) => {
        const featureName = params.featureName as string;
        const description = params.description as string;
        const tags = params.tags as string[] || [];
        const background = params.background as Array<{
            keyword: 'Given' | 'When' | 'Then' | 'And' | 'But';
            text: string;
            comment?: string;
        }> | undefined;
        const scenarios = params.scenarios as Array<{
            name: string;
            tags?: string[];
            steps: Array<{
                keyword: 'Given' | 'When' | 'Then' | 'And' | 'But';
                text: string;
                comment?: string;
                dataTable?: string[][];
            }>;
            isOutline?: boolean;
            examples?: Record<string, string>[];
            dataSourcePath?: string;
            dataSourceFilter?: string;
        }>;
        const defaultDataSourcePath = params.dataSourcePath as string | undefined;
        const defaultDataSourceFilter = params.dataSourceFilter as string || 'runFlag=Yes';
        const outputPath = params.outputPath as string | undefined;

        context.log('info', `Generating feature: ${featureName}`);

        const fileName = `${toKebabCase(featureName)}.feature`;

        // Format tags
        const formatTags = (tagList: string[]) =>
            tagList.map(t => t.startsWith('@') ? t : `@${t}`).join(' ');

        // Format a step line with optional comment
        const formatStep = (step: { keyword: string; text: string; comment?: string; dataTable?: string[][] }) => {
            const lines: string[] = [];
            if (step.comment) {
                // Support multi-line comments (split by \n)
                const commentLines = step.comment.split('\n');
                commentLines.forEach(c => lines.push(`    # ${c}`));
            }
            lines.push(`    ${step.keyword} ${step.text}`);
            if (step.dataTable) {
                const tableRows = step.dataTable.map(row =>
                    `      | ${row.join(' | ')} |`
                ).join('\n');
                lines.push(tableRows);
            }
            return lines.join('\n');
        };

        // Format description — support multi-line with proper indentation
        const descLines = description.split('\n').map(line => `  ${line}`).join('\n');

        // Generate Background section
        let backgroundSection = '';
        if (background && background.length > 0) {
            const bgSteps = background.map(step => formatStep(step)).join('\n');
            backgroundSection = `\n  Background:\n${bgSteps}\n`;
        }

        // Generate scenarios
        const scenarioTexts = scenarios.map(scenario => {
            const scenarioType = scenario.isOutline ? 'Scenario Outline' : 'Scenario';
            const scenarioTags = scenario.tags ? `  ${formatTags(scenario.tags)}\n` : '';

            const steps = scenario.steps.map(step => formatStep(step)).join('\n');

            // Build Examples section for Scenario Outline
            let examples = '';
            const scenarioDataPath = scenario.dataSourcePath || defaultDataSourcePath;
            const scenarioFilter = scenario.dataSourceFilter || defaultDataSourceFilter;

            if (scenario.isOutline && scenarioDataPath) {
                examples = `\n\n    Examples: {"type": "json", "source": "${scenarioDataPath}", "path": "$", "filter": "${scenarioFilter}"}`;
            } else if (scenario.isOutline && scenario.examples?.length) {
                const headers = Object.keys(scenario.examples[0]);
                const headerRow = `      | ${headers.join(' | ')} |`;
                const dataRows = scenario.examples.map(ex =>
                    `      | ${headers.map(h => ex[h]).join(' | ')} |`
                ).join('\n');
                examples = `\n\n    Examples:\n${headerRow}\n${dataRows}`;
            } else if (scenario.isOutline) {
                // Scenario Outline without Examples is invalid — add a warning comment
                examples = '\n\n    # WARNING: Scenario Outline requires an Examples section — provide dataSourcePath or inline examples';
            }

            return `${scenarioTags}  ${scenarioType}: ${scenario.name}\n${steps}${examples}`;
        }).join('\n\n');

        const code = `${formatTags(tags)}
Feature: ${featureName}
${descLines}
${backgroundSection}
${scenarioTexts}
`;

        // Write file if output path provided
        if (outputPath) {
            const fullPath = outputPath.endsWith('.feature') ? outputPath : path.join(outputPath, fileName);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(fullPath, code);
            CSReporter.pass(`Generated feature file: ${fullPath}`);
        }

        return createJsonResult({
            success: true,
            featureName,
            fileName,
            scenarioCount: scenarios.length,
            code,
            outputPath: outputPath || null,
        });
    })
    .build();

// ============================================================================
// Spec Test Generation Tools
// ============================================================================

const generateSpecTestTool = defineTool()
    .name('generate_spec_test')
    .description('Generate a spec test file (describe/test format) following CS Playwright framework patterns with auto-injected fixtures')
    .category('generation')
    .stringParam('suiteName', 'Test suite name', { required: true })
    .stringParam('projectPrefix', 'Project prefix', { required: true })
    .arrayParam('pageObjects', 'Page objects to use (e.g., ["LoginPage", "DashboardPage"])', 'string')
    .arrayParam('tests', 'Test case definitions with steps containing description and code', 'object', { required: true })
    .arrayParam('tags', 'Suite-level tags (e.g., ["@smoke", "@login"])', 'string')
    .stringParam('mode', 'Execution mode: serial, parallel, or default', { default: 'default' })
    .stringParam('outputPath', 'Output file path')
    .handler(async (params, context) => {
        const suiteName = params.suiteName as string;
        const projectPrefix = params.projectPrefix as string;
        const pageObjects = params.pageObjects as string[] || [];
        const tests = params.tests as Array<{
            name: string;
            tags?: string[];
            steps: Array<{ description: string; code: string }>;
            dataSource?: { type: string; source: string; filter?: string };
        }>;
        const suiteTags = params.tags as string[] || [];
        const mode = params.mode as string || 'default';
        const outputPath = params.outputPath as string | undefined;

        context.log('info', `Generating spec test: ${suiteName}`);

        const fileName = `${toKebabCase(suiteName)}.spec.ts`;

        // Derive fixture names from page objects (LoginPage → loginPage, DashboardPage → dashboardPage)
        const fixtureNames = pageObjects.map(po => {
            const clean = po.replace(/Page$/, '');
            return toCamelCase(clean) + 'Page';
        });

        // Build describe method based on mode
        const describeMethod = mode === 'serial' ? 'describe.serial' : mode === 'parallel' ? 'describe.parallel' : 'describe';

        // Build tags string for describe options
        const tagsStr = suiteTags.length > 0
            ? suiteTags.map(t => t.startsWith('@') ? `'${t}'` : `'@${t}'`).join(', ')
            : '';

        // Generate test cases using CS framework pattern
        const testCases = tests.map(tc => {
            // Build test-level tags
            const testTags = tc.tags?.length
                ? tc.tags.map(t => t.startsWith('@') ? `'${t}'` : `'@${t}'`).join(', ')
                : '';

            // Build test steps using test.step()
            const steps = (tc.steps || []).map(step => {
                const desc = step.description || 'Step';
                const code = step.code || '// TODO: implement this step';
                return `        await test.step('${desc.replace(/'/g, "\\'")}', async () => {\n            ${code}\n        });`;
            }).join('\n\n');

            // Common fixtures to destructure in test callback
            const testFixtures = [...fixtureNames, 'reporter'].join(', ');

            // Test with options (tags)
            if (testTags) {
                return `    test('${tc.name}', {\n        tags: [${testTags}],\n    }, async ({ ${testFixtures} }) => {\n${steps}\n    });`;
            }

            // Test without options
            return `    test('${tc.name}', async ({ ${testFixtures} }) => {\n${steps}\n    });`;
        }).join('\n\n');

        // Build describe options
        const describeOptions = tagsStr ? `{\n    tags: [${tagsStr}],\n}, ` : '';

        const code = `/**
 * ${suiteName}
 * Spec tests for ${projectPrefix}
 *
 * @module ${suiteName.replace(/\s+/g, '')}Spec
 * @generated ${new Date().toISOString()}
 */

import { describe, test, beforeEach, afterEach } from '@mdakhan.mak/cs-playwright-test-framework/spec';

${describeMethod}('${suiteName}', ${describeOptions}() => {

    beforeEach('Setup', async ({ reporter }) => {
        reporter.info('Starting test setup');
    });

    // ========================================================================
    // Test Cases
    // ========================================================================

${testCases}
});
`;

        // Write file if output path provided
        if (outputPath) {
            const fullPath = outputPath.endsWith('.spec.ts') ? outputPath : path.join(outputPath, fileName);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(fullPath, code);
            CSReporter.pass(`Generated spec test: ${fullPath}`);
        }

        return createJsonResult({
            success: true,
            suiteName,
            fileName,
            testCount: tests.length,
            code,
            outputPath: outputPath || null,
        });
    })
    .build();

// ============================================================================
// Database Helper Generation Tools
// ============================================================================

const generateDatabaseHelperTool = defineTool()
    .name('generate_database_helper')
    .description('Generate a database helper class following CS framework patterns. Uses named queries from .env config files via CSDBUtils.')
    .category('generation')
    .stringParam('className', 'Helper class name (e.g., "MyAppDatabaseHelper")', { required: true })
    .stringParam('dbAlias', 'Database alias (e.g., "APP_ORACLE", "AUDIT_SQLSERVER")', { required: true })
    .arrayParam('methods', 'Method definitions with name, description, query (named query key), returnType, and optional parameters', 'object', { required: true })
    .stringParam('outputPath', 'Output file path')
    .handler(async (params, context) => {
        const className = params.className as string;
        const dbAlias = params.dbAlias as string;
        const methods = params.methods as Array<{
            name: string;
            description: string;
            query: string;
            returnType: 'single' | 'row' | 'rows' | 'void' | 'exists' | 'count';
            parameters?: Array<{ name: string; type: string }>;
        }>;
        const outputPath = params.outputPath as string | undefined;

        context.log('info', `Generating database helper: ${className}`);

        const fileName = `${className}.ts`;

        // Generate methods
        const methodDefinitions = methods.map(method => {
            const mParams = method.parameters || [];
            const paramList = mParams.map(p => `${p.name}: ${p.type}`).join(', ');
            const paramValues = mParams.map(p => p.name).join(', ');
            const paramsArg = paramValues ? `, [${paramValues}]` : '';
            const desc = escapeForSingleQuote(method.description);
            const queryKey = escapeForSingleQuote(method.query);

            let returnStatement = '';
            let returnTypeStr = 'Promise<void>';

            switch (method.returnType) {
                case 'single':
                    returnTypeStr = 'Promise<string | number>';
                    returnStatement = `const result = await CSDBUtils.executeSingleValue(this.DB_ALIAS, '${queryKey}'${paramsArg});
        CSReporter.pass('${desc} completed');
        return result;`;
                    break;
                case 'row':
                    returnTypeStr = 'Promise<Record<string, any>>';
                    returnStatement = `const result = await CSDBUtils.executeSingleRow(this.DB_ALIAS, '${queryKey}'${paramsArg});
        CSReporter.pass('${desc} completed');
        return result;`;
                    break;
                case 'rows':
                    returnTypeStr = 'Promise<Record<string, any>[]>';
                    returnStatement = `const result = await CSDBUtils.executeQuery(this.DB_ALIAS, '${queryKey}'${paramsArg});
        CSReporter.pass(\`${desc} completed - \${result.rows.length} rows returned\`);
        return result.rows;`;
                    break;
                case 'void':
                    returnTypeStr = 'Promise<void>';
                    returnStatement = `await CSDBUtils.executeUpdate(this.DB_ALIAS, '${queryKey}'${paramsArg});
        CSReporter.pass('${desc} completed');`;
                    break;
                case 'exists':
                    returnTypeStr = 'Promise<boolean>';
                    returnStatement = `const result = await CSDBUtils.exists(this.DB_ALIAS, '${queryKey}'${paramsArg});
        CSReporter.pass(\`${desc} completed - exists: \${result}\`);
        return result;`;
                    break;
                case 'count':
                    returnTypeStr = 'Promise<number>';
                    returnStatement = `const result = await CSDBUtils.count(this.DB_ALIAS, '${queryKey}'${paramsArg});
        CSReporter.pass(\`${desc} completed - count: \${result}\`);
        return result;`;
                    break;
            }

            return `    /**
     * ${method.description}
     * @query ${method.query} (named query from .env config)
     */
    public static async ${method.name}(${paramList}): ${returnTypeStr} {
        CSReporter.info('${desc}');
        ${returnStatement}
    }`;
        }).join('\n\n');

        const code = `/**
 * ${className}
 * Database helper for ${dbAlias} operations
 *
 * All queries use named query keys that resolve from DB_QUERY_ entries in .env config files.
 * Example: 'GET_USER_BY_ID' resolves to DB_QUERY_GET_USER_BY_ID in config/{project}/common/{project}-db-queries.env
 *
 * @module ${className}
 * @generated ${new Date().toISOString()}
 */

import { CSDBUtils } from '@mdakhan.mak/cs-playwright-test-framework/database-utils';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';

export class ${className} {
    private static readonly DB_ALIAS = '${dbAlias}';

    // ========================================================================
    // Database Methods
    // ========================================================================

${methodDefinitions}

    // ========================================================================
    // Utility Methods
    // ========================================================================

    /**
     * Execute a custom named query
     * @param queryKey Named query key from .env config (e.g., 'GET_ACTIVE_USERS')
     * @param params Query parameters
     */
    public static async executeNamedQuery(queryKey: string, params?: any[]): Promise<Record<string, any>[]> {
        const result = await CSDBUtils.executeQuery(this.DB_ALIAS, queryKey, params);
        return result.rows;
    }

    /**
     * Verify a record exists using a named query
     * @param queryKey Named query key that returns rows (record exists if rows > 0)
     * @param params Query parameters
     */
    public static async verifyRecordExists(queryKey: string, params?: any[]): Promise<boolean> {
        return await CSDBUtils.exists(this.DB_ALIAS, queryKey, params);
    }

    /**
     * Get count using a named query
     * @param queryKey Named query key that returns a count
     * @param params Query parameters
     */
    public static async getCount(queryKey: string, params?: any[]): Promise<number> {
        return await CSDBUtils.count(this.DB_ALIAS, queryKey, params);
    }
}
`;

        // Write file if output path provided
        if (outputPath) {
            const fullPath = outputPath.endsWith('.ts') ? outputPath : path.join(outputPath, fileName);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(fullPath, code);
            CSReporter.pass(`Generated database helper: ${fullPath}`);
        }

        return createJsonResult({
            success: true,
            className,
            fileName,
            methodCount: methods.length,
            dbAlias,
            code,
            outputPath: outputPath || null,
        });
    })
    .build();

// ============================================================================
// Test Data Generation Tool
// ============================================================================

const generateTestDataFileTool = defineTool()
    .name('generate_test_data_file')
    .description('Generate a JSON test data file following PTF-ADO data source patterns. Pass actual records observed during exploration for real test data, or field definitions for synthetic generation.')
    .category('generation')
    .stringParam('fileName', 'Data file name', { required: true })
    .arrayParam('fields', 'Field definitions (used for synthetic generation when records not provided)', 'object')
    .numberParam('recordCount', 'Number of records to generate (only used with fields, not records)', { default: 5 })
    .arrayParam('records', 'Actual test data records from exploration. Each record is an object with field names as keys. When provided, these are used as-is instead of synthetic generation.', 'object')
    .stringParam('outputPath', 'Output directory path')
    .handler(async (params, context) => {
        const fileName = params.fileName as string;
        const fields = params.fields as Array<{
            name: string;
            type: 'string' | 'number' | 'boolean' | 'email' | 'date' | 'enum' | 'sequential';
            prefix?: string;
            enumValues?: string[];
            startValue?: number;
        }>;
        const recordCount = params.recordCount as number;
        const outputPath = params.outputPath as string | undefined;

        context.log('info', `Generating test data: ${fileName}`);

        const fullFileName = fileName.endsWith('.json') ? fileName : `${fileName}.json`;
        const actualRecords = params.records as Array<Record<string, unknown>> | undefined;

        let finalRecords: Record<string, unknown>[];

        if (actualRecords && actualRecords.length > 0) {
            // Use actual records from agent exploration — add testCaseId/runFlag if missing
            finalRecords = actualRecords.map((record, i) => {
                const enriched: Record<string, unknown> = {};
                if (!record.testCaseId) enriched.testCaseId = `TC_${String(i + 1).padStart(3, '0')}`;
                if (!record.runFlag) enriched.runFlag = 'Yes';
                return { ...enriched, ...record };
            });
        } else {
            // Synthetic generation from field definitions
            finalRecords = [];

            for (let i = 0; i < recordCount; i++) {
                const record: Record<string, unknown> = {
                    testCaseId: `TC_${String(i + 1).padStart(3, '0')}`,
                    runFlag: 'Yes',
                };

                for (const field of fields) {
                    switch (field.type) {
                        case 'string':
                            record[field.name] = `${field.prefix || 'test'}_${field.name}_${i + 1}`;
                            break;
                        case 'number':
                            record[field.name] = (field.startValue || 1) + i;
                            break;
                        case 'boolean':
                            record[field.name] = i % 2 === 0;
                            break;
                        case 'email':
                            record[field.name] = `test${i + 1}@example.com`;
                            break;
                        case 'date':
                            const date = new Date();
                            date.setDate(date.getDate() + i);
                            record[field.name] = date.toISOString().split('T')[0];
                            break;
                        case 'enum':
                            const enumValues = field.enumValues || ['value1', 'value2'];
                            record[field.name] = enumValues[i % enumValues.length];
                            break;
                        case 'sequential':
                            record[field.name] = (field.startValue || 1) + i;
                            break;
                    }
                }

                finalRecords.push(record);
            }
        }

        const code = JSON.stringify(finalRecords, null, 2);

        // Write file if output path provided
        if (outputPath) {
            const fullPath = path.join(outputPath, fullFileName);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(fullPath, code);
            CSReporter.pass(`Generated test data: ${fullPath}`);
        }

        return createJsonResult({
            success: true,
            fileName: fullFileName,
            recordCount: finalRecords.length,
            fields: actualRecords ? Object.keys(finalRecords[0] || {}) : (fields || []).map((f: any) => f.name),
            data: finalRecords,
            outputPath: outputPath || null,
        });
    })
    .build();

// ============================================================================
// Config File Helper Functions
// ============================================================================

/**
 * Parse .env file content and extract all keys (before first = on each line)
 */
function parseEnvKeys(content: string): Set<string> {
    const keys = new Set<string>();
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) {
                keys.add(trimmed.substring(0, eqIdx).trim());
            }
        }
    }
    return keys;
}

/**
 * Parse .env template content and extract key-value pairs with optional comments
 */
function parseEnvKeyValues(content: string): Array<{ key: string; value: string; comment?: string }> {
    const entries: Array<{ key: string; value: string; comment?: string }> = [];
    const lines = content.split('\n');
    let lastComment: string | undefined;

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') && !trimmed.startsWith('# ====')) {
            lastComment = trimmed.substring(1).trim();
            continue;
        }
        if (trimmed && !trimmed.startsWith('#')) {
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) {
                entries.push({
                    key: trimmed.substring(0, eqIdx).trim(),
                    value: trimmed.substring(eqIdx + 1).trim(),
                    comment: lastComment,
                });
                lastComment = undefined;
            }
        }
        if (!trimmed) {
            lastComment = undefined;
        }
    }
    return entries;
}

/**
 * Write a new .env file, or merge missing properties into an existing one.
 * Preserves all existing content and comments.
 */
function writeOrMerge(
    filePath: string,
    templateContent: string,
    filesGenerated: string[],
    filesUpdated: string[]
): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, templateContent);
        filesGenerated.push(filePath);
        return;
    }

    // Existing file: find missing keys and append
    const existingContent = fs.readFileSync(filePath, 'utf-8');
    const existingKeys = parseEnvKeys(existingContent);
    const templateEntries = parseEnvKeyValues(templateContent);

    const missingEntries = templateEntries.filter(entry => !existingKeys.has(entry.key));

    if (missingEntries.length === 0) {
        return; // Nothing to add
    }

    let appendSection = '\n# ============================================================================\n';
    appendSection += `# Properties added by config generator (${new Date().toISOString().split('T')[0]})\n`;
    appendSection += '# ============================================================================\n';

    for (const entry of missingEntries) {
        if (entry.comment) {
            appendSection += `# ${entry.comment}\n`;
        }
        appendSection += `${entry.key}=${entry.value}\n`;
    }

    fs.writeFileSync(filePath, existingContent.trimEnd() + '\n' + appendSection);
    filesUpdated.push(filePath);
}

/**
 * Build global.env override template for a project
 */
function buildGlobalOverrideTemplate(project: string): string {
    return `# ============================================================================
#                CS TEST AUTOMATION FRAMEWORK - GLOBAL CONFIGURATION
#                      Generated by CS Config Generator
# ============================================================================
# This file contains all configuration properties used throughout the framework.
# Properties support environment variable overrides and interpolation.
# ============================================================================

# ====================================================================================
# CORE FRAMEWORK CONFIGURATION
# ====================================================================================

# Project and environment settings
PROJECT=${project}
ENVIRONMENT=dev
# BASE_URL=https://${project}.example.com

# ====================================================================================
# BROWSER CONFIGURATION
# ====================================================================================

# Browser type: chrome | firefox | webkit | edge
BROWSER=chrome

# Run browser in headless mode
HEADLESS=false

# Browser viewport settings
BROWSER_VIEWPORT_WIDTH=1920
BROWSER_VIEWPORT_HEIGHT=1080

# Browser launch settings
BROWSER_LAUNCH_TIMEOUT=30000
BROWSER_DEVTOOLS=false
BROWSER_SLOWMO=0

# Browser security settings
BROWSER_IGNORE_HTTPS_ERRORS=true

# Browser locale and timezone
BROWSER_LOCALE=en-US
BROWSER_TIMEZONE=America/New_York

# ====================================================================================
# TIMEOUTS
# ====================================================================================

# Default timeout for all operations in milliseconds
TIMEOUT=30000

# Specific timeout configurations
BROWSER_ACTION_TIMEOUT=10000
BROWSER_NAVIGATION_TIMEOUT=30000
BROWSER_AUTO_WAIT_TIMEOUT=5000
ELEMENT_TIMEOUT=10000

# ====================================================================================
# BROWSER INSTANCE MANAGEMENT
# ====================================================================================

# Browser reuse configuration
BROWSER_REUSE_ENABLED=true
BROWSER_REUSE_CLEAR_STATE=true

# Browser health settings
BROWSER_AUTO_RESTART_ON_CRASH=true
BROWSER_MAX_RESTART_ATTEMPTS=3

# ====================================================================================
# MEDIA CAPTURE CONFIGURATION
# ====================================================================================

# Video recording: off | on | retain-on-failure | on-first-retry
BROWSER_VIDEO=retain-on-failure
VIDEO_DIR=./videos

# Screenshot configuration
SCREENSHOT_CAPTURE_MODE=on-failure
SCREENSHOT_ON_FAILURE=true

# Browser trace recording
TRACE_CAPTURE_MODE=on-failure

# Framework log level: DEBUG | INFO | WARN | ERROR
LOG_LEVEL=INFO

# ====================================================================================
# PARALLEL EXECUTION
# ====================================================================================

# Enable parallel execution
PARALLEL=false
MAX_PARALLEL_WORKERS=4
PARALLEL_WORKERS=3

# ====================================================================================
# TEST EXECUTION CONFIGURATION
# ====================================================================================

# Feature file paths
FEATURES=test/${project}/features/*.feature
FEATURE_PATH=test/${project}/features

# Test retry configuration
RETRY_COUNT=2

# Step definition paths
STEP_DEFINITIONS_PATH=test/${project}/steps;test/common/steps

# ====================================================================================
# ELEMENT INTERACTION
# ====================================================================================

# Number of retries for element operations
ELEMENT_RETRY_COUNT=3
ELEMENT_CLEAR_BEFORE_TYPE=true

# Wait for spinners to disappear before actions
WAIT_FOR_SPINNERS=true

# ====================================================================================
# CROSS-DOMAIN NAVIGATION
# ====================================================================================

# Enable cross-domain navigation support (for SSO, Netscaler, etc.)
CROSS_DOMAIN_NAVIGATION_ENABLED=false
CROSS_DOMAIN_NAVIGATION_TIMEOUT=60000

# ====================================================================================
# SELF-HEALING & AI
# ====================================================================================

# Enable self-healing for broken locators
SELF_HEALING_ENABLED=true

# Enable AI-powered features
AI_ENABLED=false
AI_CONFIDENCE_THRESHOLD=0.7

# ====================================================================================
# REPORTING CONFIGURATION
# ====================================================================================

# Report output directory
REPORTS_BASE_DIR=./reports
REPORTS_CREATE_TIMESTAMP_FOLDER=true

# Report types to generate
REPORT_TYPES=html

# Generate Excel and PDF reports
GENERATE_EXCEL_REPORT=true
GENERATE_PDF_REPORT=true

# ====================================================================================
# INTELLIGENT STEP EXECUTION
# ====================================================================================

# Enable intelligent step execution (AI-powered)
INTELLIGENT_STEP_EXECUTION_ENABLED=false
`;
}

/**
 * Build common.env template for a project
 */
function buildCommonTemplate(
    project: string,
    displayName: string,
    projectType: string,
    browser: string,
    headless: boolean,
    timeout: number,
    dbAliases: string[],
    apiTesting: boolean,
    adoIntegration: boolean
): string {
    let content = `# ============================================================================
# ${project.toUpperCase()} Project - Common Configuration
# ============================================================================
# Shared settings across all environments for the ${project} project.
# Environment-specific overrides go in environments/{env}.env
# ============================================================================

# Project Identification
PROJECT=${project}
APPLICATION_NAME=${displayName}
PROJECT_TYPE=${projectType}

# ============================================================================
# Browser Configuration
# ============================================================================
BROWSER=${browser}
HEADLESS=${headless}
TIMEOUT=${timeout}
BROWSER_ACTION_TIMEOUT=10000
BROWSER_VIEWPORT_WIDTH=1920
BROWSER_VIEWPORT_HEIGHT=1080

# Browser launch settings
BROWSER_LAUNCH_TIMEOUT=30000
BROWSER_DEVTOOLS=false
BROWSER_SLOWMO=0

# Browser security settings
BROWSER_IGNORE_HTTPS_ERRORS=true

# ============================================================================
# Test File Paths
# ============================================================================
FEATURES=test/${project}/features/*.feature
STEP_DEFINITIONS_PATH=test/${project}/steps;test/common/steps
TEST_DATA_PATH=test/${project}/data

# ============================================================================
# Execution Settings
# ============================================================================
RETRY_COUNT=2
PARALLEL=false
MAX_PARALLEL_WORKERS=4

# Cross-domain navigation (enable for SSO-based apps)
CROSS_DOMAIN_NAVIGATION_ENABLED=false

# ============================================================================
# Credentials (encrypted)
# ============================================================================
DEFAULT_USERNAME=
DEFAULT_PASSWORD=ENCRYPTED:

# ============================================================================
# Feature Flags
# ============================================================================
FEATURE_FLAGS=

# ============================================================================
# Element Interaction
# ============================================================================
ELEMENT_RETRY_COUNT=3
ELEMENT_CLEAR_BEFORE_TYPE=true
WAIT_FOR_SPINNERS=true

# ============================================================================
# Self-Healing
# ============================================================================
SELF_HEALING_ENABLED=true

# ============================================================================
# Media Capture
# ============================================================================
BROWSER_VIDEO=retain-on-failure
TRACE_CAPTURE_MODE=on-failure

# ============================================================================
# Reporting & Evidence
# ============================================================================
REPORT_TYPES=html
LOG_LEVEL=DEBUG
EVIDENCE_COLLECTION_ENABLED=true
SCREENSHOT_CAPTURE_MODE=on-failure
`;

    if (dbAliases.length > 0) {
        content += `
# ============================================================================
# Database Configuration
# ============================================================================
DB_ENABLED=true
DATABASE_CONNECTIONS=${dbAliases.join(',')}
`;
    }

    if (apiTesting) {
        content += `
# ============================================================================
# API Testing Configuration
# ============================================================================
API_TIMEOUT=30000
API_REQUEST_TIMEOUT=30000
API_RETRY_COUNT=3
API_LOG_REQUESTS=true
API_LOG_RESPONSES=true
`;
    }

    if (adoIntegration) {
        content += `
# ============================================================================
# Azure DevOps Integration
# ============================================================================
ADO_INTEGRATION_ENABLED=true
# ADO_ORGANIZATION=your-org
# ADO_PROJECT=your-project
# ADO_PAT=ENCRYPTED:
`;
    }

    return content;
}

/**
 * Build environment-specific .env template
 */
function buildEnvironmentTemplate(
    project: string,
    env: string,
    baseUrlTemplate: string,
    dbAliases: string[],
    apiTesting: boolean,
    apiBaseUrl: string,
    adoIntegration: boolean
): string {
    const envDisplay = env.toUpperCase();
    const resolvedBaseUrl = baseUrlTemplate.replace(/\{env\}/g, env).replace(/\{environment\}/gi, env);
    const resolvedApiUrl = apiBaseUrl ? apiBaseUrl.replace(/\{env\}/g, env).replace(/\{environment\}/gi, env) : '';

    // Environment-specific defaults
    const envDefaults: Record<string, { logLevel: string; headless: string; debugMode: string; devtools: string; timeout: number; actionTimeout: number; envName: string; testDataCleanup: string }> = {
        dev:     { logLevel: 'DEBUG', headless: 'false', debugMode: 'true',  devtools: 'true',  timeout: 60000, actionTimeout: 15000, envName: 'Development', testDataCleanup: 'true' },
        sit:     { logLevel: 'INFO',  headless: 'true',  debugMode: 'false', devtools: 'false', timeout: 45000, actionTimeout: 10000, envName: 'SIT',         testDataCleanup: 'true' },
        uat:     { logLevel: 'WARN',  headless: 'true',  debugMode: 'false', devtools: 'false', timeout: 30000, actionTimeout: 8000,  envName: 'UAT',         testDataCleanup: 'false' },
        qa:      { logLevel: 'INFO',  headless: 'true',  debugMode: 'false', devtools: 'false', timeout: 45000, actionTimeout: 10000, envName: 'QA',          testDataCleanup: 'true' },
        staging: { logLevel: 'INFO',  headless: 'true',  debugMode: 'false', devtools: 'false', timeout: 30000, actionTimeout: 10000, envName: 'Staging',     testDataCleanup: 'false' },
        prod:    { logLevel: 'ERROR', headless: 'true',  debugMode: 'false', devtools: 'false', timeout: 30000, actionTimeout: 8000,  envName: 'Production',  testDataCleanup: 'false' },
    };

    const defaults = envDefaults[env] || envDefaults['dev'];

    let content = `# ============================================================================
#              ${project.toUpperCase()} - ${envDisplay} ENVIRONMENT CONFIGURATION
#                      Generated by CS Config Generator
# ============================================================================
# Environment-specific settings for ${envDisplay} environment.
# These override common and global settings.
# ============================================================================

# ====================================================================================
# ENVIRONMENT IDENTIFICATION
# ====================================================================================

ENVIRONMENT_NAME=${defaults.envName}
ENVIRONMENT_TYPE=${env}

# ====================================================================================
# ENVIRONMENT URLs
# ====================================================================================

# ${envDisplay} environment URLs
BASE_URL=${resolvedBaseUrl}
`;

    if (apiTesting && resolvedApiUrl) {
        content += `API_BASE_URL=${resolvedApiUrl}\n`;
    }

    content += `
# ====================================================================================
# ENVIRONMENT BROWSER SETTINGS
# ====================================================================================

# Browser configuration for ${envDisplay}
HEADLESS=${defaults.headless}
DEBUG_MODE=${defaults.debugMode}
LOG_LEVEL=${defaults.logLevel}
BROWSER_DEVTOOLS=${defaults.devtools}
BROWSER_SLOWMO=0

# ====================================================================================
# ENVIRONMENT FEATURE FLAGS
# ====================================================================================

# ${envDisplay}-specific feature flags
FEATURE_FLAGS=

# ====================================================================================
# ENVIRONMENT TEST DATA
# ====================================================================================

# Test data configuration for ${envDisplay}
TEST_USER_PREFIX=${env}_test_
TEST_DATA_CLEANUP=${defaults.testDataCleanup}

# ====================================================================================
# ENVIRONMENT TIMEOUTS
# ====================================================================================

# ${envDisplay}-specific timeouts${env === 'dev' ? ' (more lenient for debugging)' : ''}
DEFAULT_TIMEOUT=${defaults.timeout}
BROWSER_ACTION_TIMEOUT=${defaults.actionTimeout}
`;

    if (dbAliases.length > 0) {
        content += '\n# ============================================================================\n';
        content += '# Database Connections\n';
        content += '# ============================================================================\n';

        for (const alias of dbAliases) {
            const aliasUpper = alias.toUpperCase();
            content += `
# Database: ${aliasUpper}
DB_${aliasUpper}_TYPE=sqlserver
DB_${aliasUpper}_HOST=${project}-${env}-db.example.com
DB_${aliasUpper}_PORT=1433
DB_${aliasUpper}_USERNAME=${project}_user
DB_${aliasUpper}_PASSWORD=ENCRYPTED:
DB_${aliasUpper}_DATABASE=${project}_${env}
DB_${aliasUpper}_CONNECTION_TIMEOUT=60000
DB_${aliasUpper}_REQUEST_TIMEOUT=15000
DB_${aliasUpper}_POOL_MAX=10
DB_${aliasUpper}_POOL_MIN=0
DB_${aliasUpper}_POOL_IDLE_TIMEOUT=30000
`;
        }
    }

    if (adoIntegration) {
        content += `
# ============================================================================
# Azure DevOps
# ============================================================================
# ADO_TEST_PLAN_ID=
# ADO_TEST_SUITE_ID=
`;
    }

    return content;
}

// ============================================================================
// Config Scaffold Generation Tool
// ============================================================================

const generateConfigScaffoldTool = defineTool()
    .name('generate_config_scaffold')
    .description('Generate config directory structure with sensible defaults for a project. Creates global.env, common/common.env, and environments/{env}.env files. If files exist, only appends missing properties (safe to re-run).')
    .category('generation')
    .stringParam('project', 'Project name (lowercase, e.g., "myapp", "crm")', { required: true })
    .stringParam('projectDisplayName', 'Human-readable project name (e.g., "My Application")')
    .stringParam('projectType', 'Project type: "web", "api", or "hybrid"')
    .stringParam('baseUrl', 'Base URL template (use {env} for environment placeholder, e.g., "https://myapp-{env}.company.com")')
    .arrayParam('environments', 'Environment names (default: ["dev", "sit", "uat"])', 'string')
    .arrayParam('dbAliases', 'Database connection aliases (e.g., ["APP_ORACLE", "AUDIT_SQLSERVER"])', 'string')
    .stringParam('browser', 'Default browser: "chrome", "firefox", "webkit", "edge"')
    .booleanParam('headless', 'Run headless by default')
    .numberParam('timeout', 'Default timeout in milliseconds')
    .booleanParam('adoIntegration', 'Include Azure DevOps integration properties')
    .booleanParam('apiTesting', 'Include API testing properties')
    .stringParam('apiBaseUrl', 'API base URL template (use {env} for environment placeholder)')
    .handler(async (params, context) => {
        const project = (params.project as string).toLowerCase();
        const projectDisplay = (params.projectDisplayName as string) || toPascalCase(project);
        const projectType = (params.projectType as string) || 'web';
        const baseUrlTemplate = (params.baseUrl as string) || `https://${project}-{env}.example.com`;
        const validEnvs = ['dev', 'sit', 'uat', 'qa', 'staging', 'prod', 'production'];
        const rawEnvironments = (params.environments as string[]) || ['dev', 'sit', 'uat'];
        const environments = rawEnvironments.map(e => e.toLowerCase()).filter(e => validEnvs.includes(e));
        if (environments.length === 0) {
            return createErrorResult(`Invalid environments: ${rawEnvironments.join(', ')}. Valid: ${validEnvs.join(', ')}`);
        }
        const dbAliases = (params.dbAliases as string[]) || [];
        const browser = (params.browser as string) || 'chrome';
        const headless = params.headless !== false;
        const timeout = (params.timeout as number) || 30000;
        const adoIntegration = (params.adoIntegration as boolean) || false;
        const apiTesting = (params.apiTesting as boolean) || false;
        const apiBaseUrl = (params.apiBaseUrl as string) || (apiTesting ? `https://api-${project}-{env}.example.com` : '');

        const basePath = path.join(process.cwd(), 'config', project);
        const filesGenerated: string[] = [];
        const filesUpdated: string[] = [];

        context.log('info', `Generating config scaffold for project: ${project}`);

        // 1. Generate global.env override
        const globalContent = buildGlobalOverrideTemplate(project);
        writeOrMerge(path.join(basePath, 'global.env'), globalContent, filesGenerated, filesUpdated);

        // 2. Generate common/common.env
        const commonContent = buildCommonTemplate(
            project, projectDisplay, projectType, browser, headless, timeout,
            dbAliases, apiTesting, adoIntegration
        );
        writeOrMerge(path.join(basePath, 'common', 'common.env'), commonContent, filesGenerated, filesUpdated);

        // 3. Generate environments/{env}.env for each environment
        for (const env of environments) {
            const envContent = buildEnvironmentTemplate(
                project, env, baseUrlTemplate, dbAliases, apiTesting, apiBaseUrl, adoIntegration
            );
            writeOrMerge(path.join(basePath, 'environments', `${env}.env`), envContent, filesGenerated, filesUpdated);
        }

        CSReporter.pass(`Config scaffold generated for project: ${project}`);

        return createJsonResult({
            success: true,
            project,
            basePath,
            filesGenerated,
            filesUpdated,
            environments,
            dbAliases,
            summary: {
                totalFilesGenerated: filesGenerated.length,
                totalFilesUpdated: filesUpdated.length,
                configPath: basePath,
            },
        });
    })
    .build();

// ============================================================================
// DB Queries Config Generation Tool
// ============================================================================

const generateDbQueriesConfigTool = defineTool()
    .name('generate_db_queries_config')
    .description('Generate a database queries .env file with DB_QUERY_ prefixed named queries. Creates config/{project}/common/{project}-{module}-db-queries.env. If file exists, only appends missing queries.')
    .category('generation')
    .stringParam('project', 'Project name (lowercase)', { required: true })
    .stringParam('module', 'Module name (e.g., "users", "deals", "orders")', { required: true })
    .arrayParam('queries', 'Array of query definitions: [{name: "GET_USER_BY_ID", sql: "SELECT * FROM users WHERE id = ?", description: "Fetch user by ID"}]', 'object', { required: true })
    .handler(async (params, context) => {
        const project = (params.project as string).toLowerCase();
        const module = (params.module as string).toLowerCase();
        const queries = params.queries as Array<{
            name: string;
            sql: string;
            description?: string;
        }>;

        const fileName = `${project}-${module}-db-queries.env`;
        const filePath = path.join(process.cwd(), 'config', project, 'common', fileName);

        context.log('info', `Generating DB queries config: ${fileName}`);

        // Build content
        let content = `# ============================================================================\n`;
        content += `# ${project.toUpperCase()} - ${module.toUpperCase()} Database Queries\n`;
        content += `# ============================================================================\n`;
        content += `# Named queries loaded by CSConfigurationManager and resolved by CSDBUtils.\n`;
        content += `# Usage: CSDBUtils.executeQuery('ALIAS', 'QUERY_NAME', [params])\n`;
        content += `#   or:  CSDBUtils.executeNamedQuery('ALIAS', 'QUERY_NAME', [params])\n`;
        content += `# ============================================================================\n\n`;

        for (const q of queries) {
            const queryName = q.name.toUpperCase().startsWith('DB_QUERY_')
                ? q.name.toUpperCase()
                : `DB_QUERY_${q.name.toUpperCase()}`;
            if (q.description) {
                content += `# ${q.description}\n`;
            }
            content += `${queryName}=${q.sql}\n\n`;
        }

        const filesGenerated: string[] = [];
        const filesUpdated: string[] = [];
        writeOrMerge(filePath, content, filesGenerated, filesUpdated);

        CSReporter.pass(`DB queries config generated: ${filePath}`);

        return createJsonResult({
            success: true,
            fileName,
            filePath,
            queryCount: queries.length,
            queryNames: queries.map(q => q.name),
            filesGenerated,
            filesUpdated,
        });
    })
    .build();

// ============================================================================
// Export all generation tools
// ============================================================================

export const generationTools: MCPToolDefinition[] = [
    generatePageObjectTool,
    generateStepDefinitionsTool,
    generateFeatureFileTool,
    generateSpecTestTool,
    generateDatabaseHelperTool,
    generateTestDataFileTool,
    generateConfigScaffoldTool,
    generateDbQueriesConfigTool,
];

/**
 * Register all generation tools with the registry
 */
export function registerGenerationTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(generationTools);
}
