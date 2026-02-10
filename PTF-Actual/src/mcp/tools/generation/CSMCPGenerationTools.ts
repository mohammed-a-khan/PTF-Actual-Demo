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
        return await this.${methodName}.getInputValue();
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
    .description('Generate a database helper class following PTF-ADO patterns')
    .category('generation')
    .stringParam('className', 'Helper class name', { required: true })
    .stringParam('dbAlias', 'Database alias (e.g., "APP_ORACLE", "DEFAULT")', { required: true })
    .arrayParam('methods', 'Method definitions', 'object', { required: true })
    .stringParam('outputPath', 'Output file path')
    .handler(async (params, context) => {
        const className = params.className as string;
        const dbAlias = params.dbAlias as string;
        const methods = params.methods as Array<{
            name: string;
            description: string;
            query: string;
            returnType: 'single' | 'row' | 'rows' | 'void';
            parameters?: Array<{ name: string; type: string }>;
        }>;
        const outputPath = params.outputPath as string | undefined;

        context.log('info', `Generating database helper: ${className}`);

        const fileName = `${className}.ts`;

        // Generate methods
        const methodDefinitions = methods.map(method => {
            const params = method.parameters || [];
            const paramList = params.map(p => `${p.name}: ${p.type}`).join(', ');
            const paramValues = params.map(p => p.name).join(', ');

            let returnStatement = '';
            let returnTypeStr = 'Promise<void>';

            switch (method.returnType) {
                case 'single':
                    returnTypeStr = 'Promise<string | number>';
                    returnStatement = `return await CSDBUtils.executeSingleValue(this.DB_ALIAS, query${paramValues ? `, [${paramValues}]` : ''});`;
                    break;
                case 'row':
                    returnTypeStr = 'Promise<Record<string, unknown>>';
                    returnStatement = `return await CSDBUtils.executeSingleRow(this.DB_ALIAS, query${paramValues ? `, [${paramValues}]` : ''});`;
                    break;
                case 'rows':
                    returnTypeStr = 'Promise<Record<string, unknown>[]>';
                    returnStatement = `return await CSDBUtils.executeRows(this.DB_ALIAS, query${paramValues ? `, [${paramValues}]` : ''});`;
                    break;
                case 'void':
                    returnStatement = `await CSDBUtils.getConnection(this.DB_ALIAS).then(db => db.execute(query${paramValues ? `, [${paramValues}]` : ''}));`;
                    break;
            }

            return `    /**
     * ${method.description}
     */
    public static async ${method.name}(${paramList}): ${returnTypeStr} {
        const query = \`${method.query}\`;
        ${returnStatement}
    }`;
        }).join('\n\n');

        const code = `/**
 * ${className}
 * Database helper for ${dbAlias} operations
 *
 * @module ${className}
 * @generated ${new Date().toISOString()}
 */

import { CSDBUtils } from '@mdakhan.mak/cs-playwright-test-framework/database';
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
     * Execute a custom query
     */
    public static async executeQuery(query: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
        return await CSDBUtils.executeRows(this.DB_ALIAS, query, params);
    }

    /**
     * Verify row exists
     */
    public static async verifyRowExists(table: string, criteria: Record<string, unknown>): Promise<boolean> {
        const whereClauses = Object.keys(criteria).map((col, i) => \`\${col} = $\${i + 1}\`);
        const query = \`SELECT COUNT(*) as count FROM \${table} WHERE \${whereClauses.join(' AND ')}\`;
        const result = await CSDBUtils.executeSingleValue<number>(this.DB_ALIAS, query, Object.values(criteria));
        return result > 0;
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
    .description('Generate a JSON test data file following PTF-ADO data source patterns')
    .category('generation')
    .stringParam('fileName', 'Data file name', { required: true })
    .arrayParam('fields', 'Field definitions', 'object', { required: true })
    .numberParam('recordCount', 'Number of records to generate', { default: 5 })
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

        // Generate records
        const records: Record<string, unknown>[] = [];

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

            records.push(record);
        }

        const code = JSON.stringify(records, null, 2);

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
            recordCount: records.length,
            fields: fields.map(f => f.name),
            data: records,
            outputPath: outputPath || null,
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
];

/**
 * Register all generation tools with the registry
 */
export function registerGenerationTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(generationTools);
}
