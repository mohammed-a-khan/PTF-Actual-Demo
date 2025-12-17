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
        CSReporter.info('🔨 Direct Code Generation (just conversion)');
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
        // Try to find ID first (most specific)
        const idMatch = selector.match(/#([a-zA-Z][\w-]*)/);
        if (idMatch) {
            return this.cleanName(idMatch[1]);
        }

        // Try to find aria-label (semantic name)
        const ariaLabelMatch = selector.match(/\[aria-label=["']([^"']+)["']\]/);
        if (ariaLabelMatch) {
            return this.cleanName(ariaLabelMatch[1]);
        }

        // Try to find data-testid (semantic identifier)
        const testIdMatch = selector.match(/\[data-testid=["']([^"']+)["']\]/);
        if (testIdMatch) {
            return this.cleanName(testIdMatch[1]);
        }

        // Try to find role attribute with context
        const roleMatch = selector.match(/\[role=["']([^"']+)["']\]/);
        if (roleMatch) {
            const role = roleMatch[1];
            // Extract additional context from selector if present
            const nameMatch = selector.match(/\[(?:aria-label|name)=["']([^"']+)["']\]/);
            if (nameMatch) {
                return this.cleanName(`${nameMatch[1]} ${role}`);
            }
            return this.cleanName(role);
        }

        // Extract context from parent elements in selector
        const contextName = this.extractContextFromSelector(selector);
        if (contextName) {
            return contextName;
        }

        // Try to find meaningful class names (not utility classes)
        const classMatches = selector.match(/\.([a-zA-Z][\w-]*)/g);
        if (classMatches && classMatches.length > 0) {
            // Filter out common utility/layout classes and extract semantic meaning
            const utilityPrefixes = ['oxd-', 'btn-', 'form-', 'input-', 'flex-', 'grid-', 'col-', 'row-', 'container-', 'wrapper-', 'box-', 'css-'];
            const meaningfulClasses = classMatches
                .map(c => c.substring(1)) // Remove the dot
                .filter(c => !utilityPrefixes.some(prefix => c.startsWith(prefix)))
                .filter(c => c !== 'icon' && c !== 'button' && c !== 'input'); // Filter generic names

            if (meaningfulClasses.length > 0) {
                return this.cleanName(meaningfulClasses[0]);
            }

            // If only utility classes, extract the semantic part
            const lastClass = classMatches[classMatches.length - 1].substring(1);
            const semanticPart = this.extractSemanticFromClassName(lastClass);
            if (semanticPart) {
                return semanticPart;
            }
        }

        // If all else fails, generate a descriptive generic name based on element type
        return this.generateDescriptiveGenericName(selector);
    }

    /**
     * Extract context from parent elements in selector chain
     */
    private extractContextFromSelector(selector: string): string | null {
        // Split by child combinator and analyze parent context
        const parts = selector.split(/\s*>\s*|\s+/);

        // Look for context words in the selector
        const contextPatterns = [
            { pattern: /select|dropdown|picker/i, suffix: 'Dropdown' },
            { pattern: /checkbox|check/i, suffix: 'Checkbox' },
            { pattern: /table|grid/i, suffix: 'Table' },
            { pattern: /modal|dialog|popup/i, suffix: 'Modal' },
            { pattern: /search/i, suffix: 'Search' },
            { pattern: /filter/i, suffix: 'Filter' },
            { pattern: /menu|nav/i, suffix: 'Menu' },
            { pattern: /card/i, suffix: 'Card' },
            { pattern: /form/i, suffix: 'Form' },
            { pattern: /header/i, suffix: 'Header' },
            { pattern: /footer/i, suffix: 'Footer' },
            { pattern: /sidebar/i, suffix: 'Sidebar' },
        ];

        for (const part of parts) {
            for (const { pattern, suffix } of contextPatterns) {
                if (pattern.test(part)) {
                    // Check if it's an icon within this context
                    if (selector.includes('icon')) {
                        return `${suffix.toLowerCase()}Icon`;
                    }
                    return suffix.toLowerCase() + 'Element';
                }
            }
        }

        return null;
    }

    /**
     * Extract semantic meaning from class name
     */
    private extractSemanticFromClassName(className: string): string | null {
        // Remove common prefixes
        let cleaned = className.replace(/^(oxd-|btn-|form-|input-|css-)/, '');

        // Map common patterns to semantic names
        const patterns: { [key: string]: string } = {
            'select-text': 'dropdownText',
            'select-wrapper': 'dropdownWrapper',
            'checkbox-input': 'checkboxInput',
            'checkbox-wrapper': 'checkboxWrapper',
            'table-card': 'tableCard',
            'table-cell': 'tableCell',
            'input-group': 'inputGroup',
            'button': 'actionButton',
            'icon': 'iconElement',
        };

        for (const [pattern, name] of Object.entries(patterns)) {
            if (cleaned.includes(pattern)) {
                return name;
            }
        }

        // If cleaned name is meaningful (not just generic)
        if (cleaned && cleaned.length > 3 && !['div', 'span', 'icon'].includes(cleaned)) {
            return this.toCamelCase(cleaned);
        }

        return null;
    }

    /**
     * Generate a descriptive generic name based on selector analysis
     */
    private generateDescriptiveGenericName(selector: string): string {
        // Analyze selector for hints
        if (selector.includes('checkbox')) {
            return `checkbox${this.elementCounter++}`;
        }
        if (selector.includes('select') || selector.includes('dropdown')) {
            return `dropdown${this.elementCounter++}`;
        }
        if (selector.includes('icon')) {
            // Try to determine icon type from context
            if (selector.includes('checkbox')) return `checkboxIcon${this.elementCounter++}`;
            if (selector.includes('select')) return `dropdownIcon${this.elementCounter++}`;
            if (selector.includes('table')) return `tableIcon${this.elementCounter++}`;
            if (selector.includes('action')) return `actionIcon${this.elementCounter++}`;
            return `actionIcon${this.elementCounter++}`;
        }
        if (selector.includes('button')) {
            return `actionButton${this.elementCounter++}`;
        }
        if (selector.includes('input')) {
            return `inputField${this.elementCounter++}`;
        }
        if (selector.includes('listbox') || selector.includes('option')) {
            return `listboxOption${this.elementCounter++}`;
        }

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
            path: 'codegen/features/test-scenario.feature',
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
     * Build page object content - Production quality code generation
     */
    private buildPageContent(page: PageData): string {
        // Proper imports matching production code patterns
        let content = `import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';\n`;
        content += `import { CSWebElement, CSElementFactory } from '@mdakhan.mak/cs-playwright-test-framework/element';\n`;
        content += `import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';\n\n`;

        // Class documentation
        content += `/**\n`;
        content += ` * ${page.name} Page Object\n`;
        content += ` * Generated by CS Playwright Test Framework\n`;
        content += ` */\n`;
        content += `@CSPage('${this.toKebabCase(page.name)}')\n`;
        content += `export class ${page.name}Page extends CSBasePage {\n\n`;

        // Add section header for elements
        content += `    // ===================================================================\n`;
        content += `    // PAGE ELEMENTS\n`;
        content += `    // ===================================================================\n\n`;

        // Add elements with proper decorators and alternative locators
        for (const element of page.elements) {
            const alternativeLocators = this.generateAlternativeLocators(element);
            const primaryLocator = this.determinePrimaryLocator(element.selector);

            content += `    @CSGetElement({\n`;
            content += `        ${primaryLocator.type}: '${this.escapeString(primaryLocator.value)}',\n`;
            content += `        description: '${this.escapeString(element.description)}',\n`;
            content += `        waitForVisible: true,\n`;
            content += `        selfHeal: true${alternativeLocators.length > 0 ? ',' : ''}\n`;
            if (alternativeLocators.length > 0) {
                content += `        alternativeLocators: [${alternativeLocators.map(l => `'${this.escapeString(l)}'`).join(', ')}]\n`;
            }
            content += `    })\n`;
            content += `    public ${element.name}!: CSWebElement;\n\n`;
        }

        // Add initializeElements method
        content += `    protected initializeElements(): void {\n`;
        content += `        CSReporter.debug('${page.name}Page elements initialized');\n`;
        content += `    }\n\n`;

        // Add section header for methods
        content += `    // ===================================================================\n`;
        content += `    // PAGE METHODS - Using Framework Wrapper Methods\n`;
        content += `    // ===================================================================\n\n`;

        // Add methods with proper framework wrapper patterns
        for (const method of page.methods) {
            const params = method.params.map(p => `${p.name}: ${p.type}`).join(', ');
            content += `    /**\n`;
            content += `     * ${method.gherkinStep}\n`;
            content += `     */\n`;
            content += `    public async ${method.name}(${params}): Promise<void> {\n`;
            content += `        CSReporter.info('${this.escapeString(method.gherkinStep)}');\n\n`;

            // Generate implementation based on action using framework wrapper methods
            if (method.action === 'goto') {
                // Navigation uses page.goto() with waitForPageLoad
                const urlParam = method.params.length > 0 ? method.params[0].name : "''";
                content += `        await this.page.goto(${urlParam});\n`;
                content += `        await this.waitForPageLoad();\n`;
            } else if (method.action === 'fill') {
                // Use framework wrapper methods with waitForVisible
                content += `        await this.${method.element}.waitForVisible(10000);\n`;
                content += `        await this.${method.element}.fillWithTimeout(${method.params[0].name}, 10000);\n`;
            } else if (method.action === 'click') {
                // Use framework wrapper methods with waitForVisible
                content += `        await this.${method.element}.waitForVisible(10000);\n`;
                content += `        await this.${method.element}.clickWithTimeout(10000);\n`;
                content += `        await this.waitForPageLoad();\n`;
            } else if (method.action === 'press' && method.pressKey) {
                // Handle press() with key argument
                content += `        await this.${method.element}.waitForVisible(10000);\n`;
                content += `        await this.${method.element}.press('${method.pressKey}');\n`;
            } else if (method.action.includes('toBeVisible')) {
                // Verification with proper pass/fail pattern
                content += `        const isVisible = await this.${method.element}.isVisibleWithTimeout(10000);\n\n`;
                content += `        if (isVisible) {\n`;
                content += `            CSReporter.pass('Element is visible');\n`;
                content += `        } else {\n`;
                content += `            CSReporter.fail('Element is not visible');\n`;
                content += `            throw new Error('Element visibility verification failed');\n`;
                content += `        }\n`;
            } else if (method.action.includes('toContainText')) {
                // Text verification with proper pass/fail pattern
                const textParam = method.params.length > 0 ? method.params[0].name : "'text'";
                content += `        await this.${method.element}.waitForVisible(10000);\n`;
                content += `        const actualText = await this.${method.element}.textContentWithTimeout(5000);\n\n`;
                content += `        if (actualText?.includes(${textParam})) {\n`;
                content += `            CSReporter.pass(\`Element contains expected text: \${${textParam}}\`);\n`;
                content += `        } else {\n`;
                content += `            CSReporter.fail(\`Element does not contain expected text. Expected: \${${textParam}}, Actual: \${actualText}\`);\n`;
                content += `            throw new Error('Text verification failed');\n`;
                content += `        }\n`;
            } else {
                // Default action with framework wrapper
                content += `        await this.${method.element}.waitForVisible(10000);\n`;
                content += `        await this.${method.element}.${method.action}();\n`;
            }

            content += `\n        CSReporter.pass('${this.escapeString(method.gherkinStep)} completed');\n`;
            content += `    }\n\n`;
        }

        content += `}\n\n`;
        content += `export default ${page.name}Page;\n`;
        return content;
    }

    /**
     * Determine primary locator type and value from selector
     */
    private determinePrimaryLocator(selector: string): { type: string; value: string } {
        // If it's already an XPath, use xpath
        if (selector.startsWith('/') || selector.startsWith('(//')) {
            return { type: 'xpath', value: selector };
        }

        // If it has attributes like [role=], convert to xpath for better reliability
        if (selector.includes('[role=') || selector.includes('[aria-')) {
            // Convert CSS attribute selector to XPath
            const xpathSelector = this.cssToXPath(selector);
            return { type: 'xpath', value: xpathSelector };
        }

        // Default to CSS for simple selectors
        return { type: 'css', value: selector };
    }

    /**
     * Convert simple CSS selector to XPath
     */
    private cssToXPath(css: string): string {
        // Handle [role="..."] patterns
        let xpath = css;

        // Replace [role="value"] with [@role="value"]
        xpath = xpath.replace(/\[role="([^"]+)"\]/g, '[@role="$1"]');

        // Replace [aria-label="value"] with [@aria-label="value"]
        xpath = xpath.replace(/\[aria-label="([^"]+)"\]/g, '[@aria-label="$1"]');

        // If it's a pure attribute selector, wrap with //*
        if (xpath.startsWith('[')) {
            xpath = '//*' + xpath;
        }

        return xpath;
    }

    /**
     * Generate alternative locators for self-healing
     */
    private generateAlternativeLocators(element: Element): string[] {
        const alternatives: string[] = [];
        const selector = element.selector;

        // Generate CSS alternative if primary is XPath
        if (selector.startsWith('/') || selector.startsWith('(//')) {
            // Try to generate CSS equivalent
            const cssEquivalent = this.xpathToCssHint(selector);
            if (cssEquivalent) {
                alternatives.push(`css:${cssEquivalent}`);
            }
        } else {
            // If primary is CSS, add XPath alternative
            const xpathEquivalent = this.cssToXPath(selector);
            if (xpathEquivalent !== selector) {
                alternatives.push(`xpath:${xpathEquivalent}`);
            }
        }

        // Add text-based alternative if element has a description
        if (element.description && !element.description.includes('element')) {
            const textSelector = `//*[contains(text(), '${this.escapeString(element.description)}')]`;
            alternatives.push(`xpath:${textSelector}`);
        }

        return alternatives;
    }

    /**
     * Try to convert XPath to CSS hint for alternative locator
     */
    private xpathToCssHint(xpath: string): string | null {
        // Extract role from XPath
        const roleMatch = xpath.match(/@role="([^"]+)"/);
        if (roleMatch) {
            return `[role="${roleMatch[1]}"]`;
        }

        // Extract aria-label from XPath
        const ariaMatch = xpath.match(/@aria-label="([^"]+)"/);
        if (ariaMatch) {
            return `[aria-label="${ariaMatch[1]}"]`;
        }

        return null;
    }

    /**
     * Escape string for use in single-quoted strings in generated code
     * Only escapes single quotes and backslashes - double quotes are fine in single-quoted strings
     */
    private escapeString(str: string): string {
        return str
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r');
    }

    /**
     * Convert to kebab-case for page identifiers
     */
    private toKebabCase(str: string): string {
        return str
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .replace(/[\s_]+/g, '-')
            .toLowerCase();
    }

    /**
     * Build step definitions content - Production quality with proper patterns
     */
    private buildStepsContent(page: PageData): string {
        const pageIdentifier = this.toKebabCase(page.name);
        const pagePropertyName = this.toCamelCase(page.name) + 'Page';

        // Proper imports matching production code patterns
        let content = `import {\n`;
        content += `    CSBDDStepDef, Page, StepDefinitions,\n`;
        content += `    CSScenarioContext, CSFeatureContext, CSBDDContext\n`;
        content += `} from '@mdakhan.mak/cs-playwright-test-framework/bdd';\n`;
        content += `import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';\n`;
        content += `import { ${page.name}Page } from '../pages/${page.name}Page';\n\n`;

        // Class documentation
        content += `/**\n`;
        content += ` * ${page.name} Step Definitions\n`;
        content += ` * Generated by CS Playwright Test Framework\n`;
        content += ` */\n`;
        content += `@StepDefinitions\n`;
        content += `export class ${page.name}Steps {\n\n`;

        // Page injection with proper decorator
        content += `    @Page('${pageIdentifier}')\n`;
        content += `    private ${pagePropertyName}!: ${page.name}Page;\n\n`;

        // Context instances
        content += `    private scenarioContext = CSScenarioContext.getInstance();\n`;
        content += `    private featureContext = CSFeatureContext.getInstance();\n`;
        content += `    private bddContext = CSBDDContext.getInstance();\n\n`;

        // Add section header for step definitions
        content += `    // ===================================================================\n`;
        content += `    // STEP DEFINITIONS - Using Cucumber Expressions\n`;
        content += `    // ===================================================================\n\n`;

        // Add step methods with proper Cucumber expressions (NOT regex)
        for (const method of page.methods) {
            const gherkinText = method.gherkinStep.replace(/^(Given|When|Then)\s+/, '');

            // Convert to Cucumber expression pattern (NOT regex!)
            // Replace quoted strings with {string} parameter
            const cucumberPattern = gherkinText.replace(/"([^"]+)"/g, '{string}');

            // Generate step method name that's unique (avoid collision with page method)
            const stepMethodName = `step${this.toPascalCase(method.name)}`;

            const params = method.params.map(p => `${p.name}: ${p.type}`).join(', ');
            const paramNames = method.params.map(p => p.name).join(', ');

            content += `    /**\n`;
            content += `     * Step: ${gherkinText}\n`;
            content += `     */\n`;
            content += `    @CSBDDStepDef('${this.escapeString(cucumberPattern)}')\n`;
            content += `    async ${stepMethodName}(${params}): Promise<void> {\n`;
            content += `        CSReporter.info('Executing step: ${this.escapeString(gherkinText)}');\n\n`;

            // Call page object method (NOT recursive step call!)
            content += `        // Call page object method to perform the action\n`;
            content += `        await this.${pagePropertyName}.${method.name}(${paramNames});\n\n`;

            content += `        CSReporter.pass('Step completed: ${this.escapeString(gherkinText)}');\n`;
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
