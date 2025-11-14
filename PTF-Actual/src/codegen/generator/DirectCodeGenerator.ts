/**
 * DIRECT CODE GENERATOR
 *
 * Simple, straightforward conversion of Playwright actions to CS Framework code.
 * NO "intelligence" - just direct, accurate mapping.
 *
 * Philosophy:
 * - One action = one element + one method
 * - Sequential test flow = sequential Gherkin steps
 * - No pattern detection BS - just convert what's there
 */

import { Action, GeneratedCSCode } from '../types';
import { CSReporter } from '../../reporter/CSReporter';

interface Element {
    name: string;
    selector: string;
    selectorType: string;
    description: string;
}

interface PageMethod {
    name: string;
    element: string;
    action: string;
    params: Array<{ name: string; type: string }>;
    gherkinStep: string;
    pressKey?: string; // For press() actions
}

interface PageData {
    name: string;
    elements: Element[];
    methods: PageMethod[];
}

export class DirectCodeGenerator {
    private elementCounter = 0;
    private pages: Map<string, PageData> = new Map();
    private elementRegistry: Map<string, Set<string>> = new Map(); // Track created elements per page
    private methodRegistry: Map<string, Set<string>> = new Map(); // Track created method names per page
    private elementNameRegistry: Map<string, Set<string>> = new Map(); // Track element property names per page

    /**
     * Generate CS Framework code directly from actions
     */
    public generate(actions: Action[]): GeneratedCSCode {
        CSReporter.info('🔨 Direct Code Generation (No BS, just conversion)');
        CSReporter.info(`   Processing ${actions.length} actions sequentially...`);

        // Reset state
        this.elementCounter = 0;
        this.pages.clear();
        this.elementRegistry.clear();
        this.methodRegistry.clear();
        this.elementNameRegistry.clear();

        // Process each action sequentially
        const gherkinSteps: string[] = [];
        let currentPage = 'Login'; // Start with login page

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];

            // Determine page from URL or navigation
            if (action.type === 'navigation' && action.method === 'goto') {
                currentPage = this.extractPageFromUrl(action.args[0] as string);
            } else if (action.type === 'click' && action.target?.type === 'getByRole' &&
                       action.target?.selector === 'link') {
                // Navigation link clicked
                const linkName = action.target?.options?.name;
                if (linkName && ['Admin', 'PIM', 'Leave', 'Time', 'Recruitment'].includes(linkName)) {
                    currentPage = linkName;
                }
            }

            // Convert action to page element + method + Gherkin
            const result = this.convertAction(action, currentPage, i);
            if (result) {
                gherkinSteps.push(result.gherkinStep);
            }
        }

        // Build the output
        return this.buildOutput(gherkinSteps);
    }

    /**
     * Convert a single action to element + method + Gherkin
     */
    private convertAction(action: Action, pageName: string, index: number): { gherkinStep: string } | null {
        // Get or create page
        if (!this.pages.has(pageName)) {
            this.pages.set(pageName, {
                name: pageName,
                elements: [],
                methods: []
            });
            this.elementRegistry.set(pageName, new Set());
            this.methodRegistry.set(pageName, new Set());
            this.elementNameRegistry.set(pageName, new Set());
        }
        const page = this.pages.get(pageName)!;
        const pageElementRegistry = this.elementRegistry.get(pageName)!;
        const pageMethodRegistry = this.methodRegistry.get(pageName)!;
        const pageElementNameRegistry = this.elementNameRegistry.get(pageName)!;

        // Extract element info (but skip for navigation actions)
        let elementName = '';
        if (action.type !== 'navigation') {
            const baseElementName = this.generateElementName(action);
            const selector = this.extractSelector(action);
            const selectorType = action.target?.type || 'locator';
            const elementKey = `${baseElementName}:${selector}`; // Unique key for deduplication

            // Only create element if it doesn't exist and selector is not empty (deduplication)
            if (!pageElementRegistry.has(elementKey) && selector) {
                // Ensure element name is unique (deduplicate property names)
                let uniqueElementName = this.sanitizePropertyName(baseElementName);
                let counter = 2;
                while (pageElementNameRegistry.has(uniqueElementName)) {
                    // Generate descriptive suffix based on target type
                    const suffix = this.getElementTypeSuffix(action, counter);
                    uniqueElementName = this.sanitizePropertyName(`${baseElementName}${suffix}`);
                    counter++;
                }
                pageElementNameRegistry.add(uniqueElementName);
                elementName = uniqueElementName;

                const element: Element = {
                    name: elementName,
                    selector: selector,
                    selectorType: selectorType,
                    description: this.generateElementDescription(action)
                };
                page.elements.push(element);
                pageElementRegistry.add(elementKey);
            } else {
                // Element already exists, use the existing name
                const existingElement = page.elements.find(e =>
                    `${this.generateElementName(action)}:${e.selector}` === elementKey
                );
                elementName = existingElement?.name || this.sanitizePropertyName(baseElementName);
            }
        }

        // Create method based on action type
        let methodName: string;
        let gherkinStep: string;
        let params: Array<{ name: string; type: string }> = [];
        let pressKey: string | undefined;

        switch (action.type) {
            case 'navigation':
                const url = action.args[0] as string;
                methodName = 'navigateToLoginPage';
                gherkinStep = 'Given I navigate to the login page';
                params = [{ name: 'url', type: 'string' }];
                break;

            case 'fill':
                const fieldName = this.extractFieldName(action);
                const value = action.args[0] as string;
                methodName = `enter${this.toPascalCase(fieldName)}`;
                gherkinStep = `When I enter "${value}" in ${fieldName}`;
                params = [{ name: fieldName, type: 'string' }];
                break;

            case 'click':
                const clickTarget = this.extractClickTarget(action);
                methodName = `click${this.toPascalCase(clickTarget)}`;
                gherkinStep = `When I click ${clickTarget}`;
                break;

            case 'assertion':
                const assertTarget = this.extractAssertionTarget(action);
                const assertType = this.extractAssertionType(action);

                // Handle toContainText specially - it needs a text parameter
                if (action.method.includes('toContainText')) {
                    const textToCheck = action.args && action.args.length > 0 ? action.args[0] as string : 'text';
                    methodName = `verify${this.toPascalCase(assertTarget)}Contains`;
                    gherkinStep = `Then I see ${assertTarget} contains "${textToCheck}"`;
                    params = [{ name: 'expectedText', type: 'string' }];
                } else {
                    methodName = `verify${this.toPascalCase(assertTarget)}${this.toPascalCase(assertType)}`;
                    gherkinStep = `Then I see ${assertTarget} is ${assertType}`;
                }
                break;

            default:
                // Handle press() action specially
                if (action.method === 'press' && action.args && action.args.length > 0) {
                    pressKey = action.args[0] as string;
                    const fieldName = this.extractFieldName(action);
                    methodName = `press${this.toPascalCase(pressKey)}On${this.toPascalCase(fieldName)}`;
                    gherkinStep = `When I press ${pressKey} on ${fieldName}`;
                } else {
                    methodName = `perform${this.toPascalCase(action.method)}`;
                    gherkinStep = `When I ${action.method}`;
                }
        }

        // Method name deduplication - add counter if method name already exists
        let finalMethodName = methodName;
        let counter = 2;
        while (pageMethodRegistry.has(finalMethodName)) {
            finalMethodName = `${methodName}${counter}`;
            counter++;
        }
        pageMethodRegistry.add(finalMethodName);

        // Add method to page
        page.methods.push({
            name: finalMethodName,
            element: elementName,
            action: action.method,
            params: params,
            gherkinStep: gherkinStep,
            pressKey: pressKey
        } as any);

        return { gherkinStep };
    }

    /**
     * Extract page name from URL
     */
    private extractPageFromUrl(url: string): string {
        if (url.includes('login')) return 'Login';
        if (url.includes('admin')) return 'Admin';
        if (url.includes('pim')) return 'PIM';
        if (url.includes('dashboard')) return 'Dashboard';
        return 'Page';
    }

    /**
     * Extract selector from action
     * Returns proper CSS selector format for CS Framework
     */
    private extractSelector(action: Action): string {
        if (!action.target) return '';

        switch (action.target.type) {
            case 'getByRole':
                const role = action.target.selector;
                const name = action.target.options?.name;
                const exact = action.target.options?.exact;
                // Convert to proper CSS selector format
                if (name) {
                    // Try to use accessible name selector
                    return `[role="${role}"][aria-label="${name}"]`;
                }
                return `[role="${role}"]`;

            case 'getByText':
                const text = action.target.selector;
                // Use XPath for text content matching (more reliable than CSS text selectors)
                // Use double quotes for XPath to avoid escaping issues with single quotes in text
                const escapedText = text.replace(/"/g, '&quot;');
                return `//*[contains(text(), "${escapedText}")]`;

            case 'locator':
                return action.target.selector;

            default:
                return action.target.selector || '';
        }
    }

    /**
     * Generate element name from action
     */
    private generateElementName(action: Action): string {
        const base = this.extractFieldName(action);
        return this.toCamelCase(base);
    }

    /**
     * Generate element description
     */
    private generateElementDescription(action: Action): string {
        return this.extractFieldName(action);
    }

    /**
     * Extract field name from action
     */
    private extractFieldName(action: Action): string {
        if (action.target?.options?.name) {
            return this.cleanName(action.target.options.name);
        }
        if (action.target?.selector) {
            // For locator type (raw CSS selectors), extract meaningful name
            if (action.target.type === 'locator') {
                return this.extractNameFromCSSSelector(action.target.selector);
            }
            return this.cleanName(action.target.selector);
        }
        return `element${this.elementCounter++}`;
    }

    /**
     * Extract a meaningful name from a CSS selector
     * Analyzes the selector to find the most descriptive part
     */
    private extractNameFromCSSSelector(selector: string): string {
        // Try to find meaningful class names (not utility classes)
        const classMatches = selector.match(/\.([a-zA-Z][\w-]*)/g);
        if (classMatches && classMatches.length > 0) {
            // Filter out common utility/layout classes
            const utilityPrefixes = ['oxd-', 'btn-', 'form-', 'input-', 'flex-', 'grid-', 'col-', 'row-', 'container-', 'wrapper-', 'box-'];
            const meaningfulClasses = classMatches
                .map(c => c.substring(1)) // Remove the dot
                .filter(c => !utilityPrefixes.some(prefix => c.startsWith(prefix)));

            if (meaningfulClasses.length > 0) {
                // Use the first meaningful class name
                return meaningfulClasses[0];
            }

            // If no meaningful classes, use the last class (often most specific)
            const lastClass = classMatches[classMatches.length - 1].substring(1);
            // Remove common prefixes
            const withoutPrefix = lastClass.replace(/^(oxd-|btn-|form-|input-)/, '');
            if (withoutPrefix) {
                return withoutPrefix;
            }
        }

        // Try to find ID
        const idMatch = selector.match(/#([a-zA-Z][\w-]*)/);
        if (idMatch) {
            return idMatch[1];
        }

        // Try to find data attributes with meaningful names
        const dataAttrMatch = selector.match(/\[data-[\w-]+=["']([^"']+)["']\]/);
        if (dataAttrMatch) {
            return this.cleanName(dataAttrMatch[1]);
        }

        // Try to find aria-label
        const ariaLabelMatch = selector.match(/\[aria-label=["']([^"']+)["']\]/);
        if (ariaLabelMatch) {
            return this.cleanName(ariaLabelMatch[1]);
        }

        // Try to extract element type (button, input, etc.)
        const elementMatch = selector.match(/^([a-z]+)[\[\.\:#\s>+~]/);
        if (elementMatch && elementMatch[1] !== 'div' && elementMatch[1] !== 'span') {
            return `${elementMatch[1]}Element`;
        }

        // Last resort: look for the most specific part of the selector
        // If selector has child combinators, use the last part
        const parts = selector.split(/\s*>\s*/);
        if (parts.length > 1) {
            const lastPart = parts[parts.length - 1].trim();
            // Try to extract class from last part
            const lastClassMatch = lastPart.match(/\.([a-zA-Z][\w-]*)/);
            if (lastClassMatch) {
                const className = lastClassMatch[1].replace(/^(oxd-|btn-|form-|input-)/, '');
                if (className) {
                    return className;
                }
            }
        }

        // If all else fails, generate a generic name
        return `element${this.elementCounter++}`;
    }

    /**
     * Extract click target description
     */
    private extractClickTarget(action: Action): string {
        if (action.target?.options?.name) {
            return this.cleanName(action.target.options.name);
        }
        if (action.target?.selector) {
            // Use role or selector type for better description
            if (action.target.type === 'getByRole') {
                const role = action.target.selector;
                return role === 'button' ? 'button' : `${role} element`;
            }
            // For locator type (raw CSS selectors), extract meaningful name
            if (action.target.type === 'locator') {
                return this.extractNameFromCSSSelector(action.target.selector);
            }
            return this.cleanName(action.target.selector);
        }
        return 'element';
    }

    /**
     * Extract assertion target
     */
    private extractAssertionTarget(action: Action): string {
        // Use target info if available (from parser)
        if (action.target?.options?.name) {
            return this.cleanName(action.target.options.name);
        }
        if (action.target?.selector) {
            // For locator type (raw CSS selectors), extract meaningful name
            if (action.target.type === 'locator') {
                return this.extractNameFromCSSSelector(action.target.selector);
            }
            return this.cleanName(action.target.selector);
        }

        // Fallback: Look inside expect() expression for the target
        const expr = action.expression;
        const match = expr.match(/getByText\(['"]([^'"]+)['"]\)/) ||
                     expr.match(/getByRole\([^,]+,\s*\{[^}]*name:\s*['"]([^'"]+)['"]/);

        if (match) {
            return this.cleanName(match[1]);
        }
        return 'element';
    }

    /**
     * Extract assertion type
     */
    private extractAssertionType(action: Action): string {
        if (action.method.includes('toBeVisible')) return 'visible';
        if (action.method.includes('toContainText')) return 'displayed';
        if (action.method.includes('toHaveText')) return 'shown';
        return 'present';
    }

    /**
     * Clean name for use in code
     */
    private cleanName(name: string): string {
        return name
            .replace(/[^a-zA-Z0-9\s]/g, ' ')
            .trim()
            .replace(/\s+/g, ' ');
    }

    /**
     * Convert to PascalCase
     */
    private toPascalCase(str: string): string {
        return str
            .split(/[\s-_]+/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('');
    }

    /**
     * Convert to camelCase
     */
    private toCamelCase(str: string): string {
        const pascal = this.toPascalCase(str);
        return pascal.charAt(0).toLowerCase() + pascal.slice(1);
    }

    /**
     * Sanitize property name to be valid JavaScript identifier
     * - Remove invalid characters
     * - Prefix with underscore if starts with number
     * - Handle empty strings
     */
    private sanitizePropertyName(name: string): string {
        if (!name) return 'element';

        // Replace invalid characters with empty string
        let sanitized = name.replace(/[^a-zA-Z0-9_$]/g, '');

        // If starts with number, prefix with descriptive text
        if (/^\d/.test(sanitized)) {
            sanitized = 'item' + sanitized;
        }

        // Ensure not empty
        if (!sanitized) {
            return 'element';
        }

        return sanitized;
    }

    /**
     * Get descriptive suffix for element type to help with deduplication
     */
    private getElementTypeSuffix(action: Action, counter: number): string {
        if (action.target?.type === 'getByRole') {
            const role = action.target.selector;
            // Use role as suffix
            if (role === 'link') return 'Link';
            if (role === 'button') return 'Button';
            if (role === 'heading') return 'Heading';
            if (role === 'textbox') return 'Input';
            return this.toPascalCase(role);
        }

        // Default to counter
        return counter.toString();
    }

    /**
     * Build final output
     */
    private buildOutput(gherkinSteps: string[]): GeneratedCSCode {
        const pageObjects: any[] = [];
        const stepDefinitions: any[] = [];

        // Build page objects
        for (const [pageName, pageData] of this.pages.entries()) {
            pageObjects.push({
                className: `${pageName}Page`,
                fileName: `${pageName}Page.ts`,
                content: this.buildPageContent(pageData)
            });

            stepDefinitions.push({
                className: `${pageName}Steps`,
                fileName: `${pageName}Steps.ts`,
                content: this.buildStepsContent(pageData)
            });
        }

        // Build single feature file
        const feature = {
            fileName: 'test-scenario.feature',
            path: 'test/features/test-scenario.feature',
            content: this.buildFeatureContent(gherkinSteps),
            scenarios: [{
                name: 'Execute recorded test flow',
                tags: [],
                steps: gherkinSteps.map(step => ({
                    keyword: (step.startsWith('Given') ? 'Given' : step.startsWith('Then') ? 'Then' : 'When') as 'Given' | 'When' | 'Then',
                    text: step.replace(/^(Given|When|Then)\s+/, '')
                }))
            }]
        };

        return {
            feature,
            features: [feature],
            pageObjects,
            stepDefinitions,
            components: [],
            metadata: {
                timestamp: Date.now(),
                version: '1.0.0',
                generatedBy: 'DirectCodeGenerator',
                intelligence: {
                    patterns: 0,
                    pages: this.pages.size,
                    steps: stepDefinitions.length,
                    features: 1
                }
            }
        };
    }

    /**
     * Build page object content
     */
    private buildPageContent(page: PageData): string {
        let content = `import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';\n`;
        content += `import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';\n`;
        content += `import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';\n`;
        content += `import { expect } from '@mdakhan.mak/cs-playwright-test-framework/assertions';\n\n`;

        content += `@CSPage('${page.name.toLowerCase()}')\n`;
        content += `export class ${page.name}Page extends CSBasePage {\n\n`;

        // Add elements
        for (const element of page.elements) {
            content += `    // ${element.description}\n`;
            content += `    @CSGetElement({\n`;
            content += `        css: '${element.selector}',\n`;
            content += `        description: '${element.description}',\n`;
            content += `        waitForVisible: true,\n`;
            content += `        selfHeal: true\n`;
            content += `    })\n`;
            content += `    public ${element.name}!: CSWebElement;\n\n`;
        }

        content += `    protected initializeElements(): void {\n`;
        content += `        CSReporter.debug('${page.name}Page elements initialized');\n`;
        content += `    }\n\n`;

        // Add methods
        for (const method of page.methods) {
            const params = method.params.map(p => `${p.name}: ${p.type}`).join(', ');
            content += `    /**\n`;
            content += `     * ${method.gherkinStep}\n`;
            content += `     */\n`;
            content += `    public async ${method.name}(${params}): Promise<void> {\n`;
            content += `        CSReporter.info('${method.gherkinStep}');\n`;

            // Generate implementation based on action
            if (method.action === 'goto') {
                // Navigation uses page.goto()
                content += `        await this.page.goto(${method.params.length > 0 ? method.params[0].name : "''"});\n`;
            } else if (method.action === 'fill') {
                content += `        await this.${method.element}.fill(${method.params[0].name});\n`;
            } else if (method.action === 'click') {
                content += `        await this.${method.element}.click();\n`;
            } else if (method.action === 'press' && method.pressKey) {
                // Handle press() with key argument
                content += `        await this.${method.element}.press('${method.pressKey}');\n`;
            } else if (method.action.includes('toBeVisible')) {
                content += `        await expect().toBeVisible(this.${method.element});\n`;
            } else if (method.action.includes('toContainText')) {
                // Use parameter if method has params, otherwise hardcode text
                const textParam = method.params.length > 0 ? method.params[0].name : "'text'";
                content += `        await expect().toContainText(this.${method.element}, ${textParam});\n`;
            } else {
                content += `        await this.${method.element}.${method.action}();\n`;
            }

            content += `        CSReporter.pass('${method.gherkinStep} completed');\n`;
            content += `    }\n\n`;
        }

        content += `}\n`;
        return content;
    }

    /**
     * Build step definitions content
     */
    private buildStepsContent(page: PageData): string {
        let content = `import {\n`;
        content += `    CSBDDStepDef, Page, StepDefinitions,\n`;
        content += `    CSScenarioContext, CSFeatureContext, CSBDDContext\n`;
        content += `} from '@mdakhan.mak/cs-playwright-test-framework/bdd';\n`;
        content += `import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';\n`;
        content += `import { ${page.name}Page } from '../pages/${page.name}Page';\n\n`;

        content += `@StepDefinitions\n`;
        content += `export class ${page.name}Steps {\n\n`;

        content += `    @Page('${page.name.toLowerCase()}')\n`;
        content += `    private ${this.toCamelCase(page.name)}Page!: ${page.name}Page;\n\n`;

        content += `    private scenarioContext = CSScenarioContext.getInstance();\n`;
        content += `    private featureContext = CSFeatureContext.getInstance();\n`;
        content += `    private bddContext = CSBDDContext.getInstance();\n\n`;

        // Add step methods
        for (const method of page.methods) {
            const gherkinText = method.gherkinStep.replace(/^(Given|When|Then)\s+/, '');
            const cucumberPattern = gherkinText.replace(/"([^"]+)"/g, '{string}');

            const params = method.params.map(p => `${p.name}: ${p.type}`).join(', ');

            content += `    @CSBDDStepDef('${cucumberPattern}')\n`;
            content += `    async ${method.name}(${params}) {\n`;
            content += `        CSReporter.info('${gherkinText}');\n`;
            content += `        await this.${this.toCamelCase(page.name)}Page.${method.name}(${method.params.map(p => p.name).join(', ')});\n`;
            content += `        CSReporter.pass('Step completed: ${gherkinText}');\n`;
            content += `    }\n\n`;
        }

        content += `}\n\n`;
        content += `export default ${page.name}Steps;\n`;
        return content;
    }

    /**
     * Build feature file content
     */
    private buildFeatureContent(steps: string[]): string {
        let content = `Feature: Complete Test Scenario\n`;
        content += `  Automated test scenario following the recorded flow\n\n`;
        content += `  Scenario: Execute recorded test flow\n`;

        for (const step of steps) {
            content += `    ${step}\n`;
        }

        return content;
    }
}
