/**
 * INTELLIGENT CODE GENERATOR - v2.0
 *
 * Integrates 5 intelligence layers to generate optimal CS Framework code:
 * 1. Assertion Intelligence - understands verification intent
 * 2. Pattern Recognition - detects UI workflows
 * 3. Context Extraction - semantic understanding
 * 4. Intelligent Naming - meaningful identifiers
 * 5. Architecture Organizer - proper structure
 */

import { Action, GeneratedCSCode } from '../types';
import { CSReporter } from '../../reporter/CSReporter';
import { AssertionIntelligenceEngine, ExtractedAssertion } from '../intelligence/AssertionIntelligenceEngine';
import { PatternRecognitionEngine, Pattern } from '../intelligence/PatternRecognitionEngine';
import { ContextExtractor, ElementContext } from '../intelligence/ContextExtractor';
import { IntelligentNamingSystem } from '../intelligence/IntelligentNamingSystem';
import {
    ArchitectureOrganizer,
    ArchitectureOutput,
    ElementDefinition,
    MethodDefinition,
    ParameterDefinition
} from '../intelligence/ArchitectureOrganizer';

export class IntelligentCodeGenerator {
    private assertionEngine: AssertionIntelligenceEngine;
    private patternEngine: PatternRecognitionEngine;
    private contextExtractor: ContextExtractor;
    private namingSystem: IntelligentNamingSystem;
    private architectureOrganizer: ArchitectureOrganizer;

    constructor() {
        this.assertionEngine = new AssertionIntelligenceEngine();
        this.patternEngine = new PatternRecognitionEngine();
        this.contextExtractor = new ContextExtractor();
        this.namingSystem = new IntelligentNamingSystem();
        this.architectureOrganizer = new ArchitectureOrganizer();
    }

    /**
     * Generate intelligent CS Framework code from Playwright recording
     */
    public async generate(actions: Action[]): Promise<GeneratedCSCode> {
        CSReporter.info('🧠 Starting intelligent code generation...');

        // LAYER 1: Detect patterns (dropdowns, modals, navigation, etc.)
        const patterns = this.patternEngine.detectPatterns(actions);

        // LAYER 2: Extract context for each action
        const contexts = new Map<Action, ElementContext>();
        for (const action of actions) {
            const context = this.contextExtractor.extractElementContext(action, patterns, actions);
            contexts.set(action, context);
        }

        // LAYER 3: Analyze assertions
        const assertions = new Map<Action, ExtractedAssertion>();
        for (const action of actions) {
            if (action.type === 'assertion') {
                const previousActions = actions.slice(0, actions.indexOf(action));
                const assertion = this.assertionEngine.analyzeAssertion(action, previousActions);
                if (assertion) {
                    assertions.set(action, assertion);
                }
            }
        }

        // LAYER 4: Generate intelligent names and create elements
        const elements = this.generateElements(actions, contexts, patterns);

        // LAYER 5: Generate intelligent methods from patterns
        const methods = this.generateMethods(patterns, contexts, assertions);

        // LAYER 6: Organize into proper architecture
        const architecture = this.architectureOrganizer.organize(
            actions,
            patterns,
            contexts,
            elements,
            methods
        );

        // Build final code output
        const code = this.buildCodeOutput(architecture);

        CSReporter.info('✅ Intelligent code generation complete!');

        return code;
    }

    /**
     * Generate element definitions with intelligent names
     * Creates elements for pattern actions AND frequently used elements
     */
    private generateElements(
        actions: Action[],
        contexts: Map<Action, ElementContext>,
        patterns: Pattern[]
    ): Map<string, ElementDefinition> {
        // Build set of actions that are part of patterns (these should always have elements)
        const patternActionSet = new Set<Action>();
        for (const pattern of patterns) {
            for (const action of pattern.actions) {
                if (action.type !== 'assertion' && action.type !== 'navigation' && action.target) {
                    patternActionSet.add(action);
                }
            }
        }

        // First pass: count element usage per module
        const elementUsage = new Map<string, { count: number; actions: Action[]; context: ElementContext; isPatternAction: boolean }>();

        for (const action of actions) {
            // Skip navigation and actions without targets
            if (action.type === 'navigation' || !action.target) continue;

            const context = contexts.get(action);
            if (!context) continue;

            // Create unique key: module + locatorType + selector + name
            const key = `${context.pageModule}:${action.target.type}:${action.target.selector}:${action.target.options?.name || ''}`;

            if (!elementUsage.has(key)) {
                elementUsage.set(key, { count: 0, actions: [], context, isPatternAction: false });
            }

            const usage = elementUsage.get(key)!;
            usage.count++;
            usage.actions.push(action);

            // Mark if this is a pattern action OR assertion (assertions should always have elements)
            if (patternActionSet.has(action) || action.type === 'assertion') {
                usage.isPatternAction = true;
            }
        }

        // Second pass: create elements for pattern actions OR frequently used ones
        const elements = new Map<string, ElementDefinition>();
        const usedNames = new Set<string>();

        for (const [key, usage] of elementUsage.entries()) {
            // Create element if:
            // 1. Part of a detected pattern (login, search, dropdown, etc.)
            // 2. Used 2+ times
            // 3. Has specific important role (buttons, etc.)
            const action = usage.actions[0];
            const isImportantElement = this.isImportantElement(action.target, usage.context);

            if (usage.isPatternAction || usage.count >= 2 || isImportantElement) {
                // Generate intelligent element name
                let elementName = this.namingSystem.generateElementName(action, usage.context);

                // Make unique by adding context, not just numbers
                if (usedNames.has(elementName)) {
                    const modulePrefix = usage.context.pageModule.toLowerCase();
                    elementName = `${modulePrefix}${elementName.charAt(0).toUpperCase() + elementName.slice(1)}`;

                    if (usedNames.has(elementName)) {
                        const selectorHint = this.generateSelectorHint(action.target);
                        elementName = `${elementName}${selectorHint}`;

                        // Last resort: skip this element (use inline instead)
                        if (usedNames.has(elementName)) {
                            continue;
                        }
                    }
                }
                usedNames.add(elementName);

                // Create element definition
                const element: ElementDefinition = {
                    name: elementName,
                    selector: action.target?.selector || '',
                    locatorType: action.target?.type || 'locator',
                    options: action.target?.options,
                    module: usage.context.pageModule
                };

                elements.set(elementName, element);
            }
        }

        return elements;
    }

    /**
     * Check if element is important enough to always create (buttons, inputs, etc.)
     */
    private isImportantElement(target: any, context: ElementContext): boolean {
        // Always create elements for important buttons
        if (target.type === 'getByRole' && target.selector === 'button') {
            const name = target.options?.name?.toLowerCase() || '';
            if (name.includes('search') || name.includes('submit') ||
                name.includes('login') || name.includes('save') ||
                name.includes('cancel') || name.includes('delete') ||
                name.includes('add') || name.includes('create')) {
                return true;
            }
        }

        // Always create elements for textboxes (input fields)
        if (target.type === 'getByRole' && target.selector === 'textbox') {
            return true;
        }

        // Always create elements for inputs with critical placeholders/names
        if (target.type === 'getByPlaceholder' || target.type === 'getByLabel') {
            const name = (target.options?.name || target.selector || '').toLowerCase();
            if (name.includes('username') || name.includes('password') ||
                name.includes('email') || name.includes('search') ||
                name.includes('name') || name.includes('phone')) {
                return true;
            }
        }

        return false;
    }

    /**
     * Generate selector hint for unique naming
     */
    private generateSelectorHint(target: any): string {
        if (!target) return '';

        // For buttons/links with names, use the name
        if (target.options?.name) {
            const name = target.options.name
                .replace(/[^a-zA-Z0-9]/g, '')
                .substring(0, 15);
            return name.charAt(0).toUpperCase() + name.slice(1);
        }

        // For role-based, use role
        if (target.type === 'getByRole') {
            return target.selector.charAt(0).toUpperCase() + target.selector.slice(1);
        }

        return '';
    }

    /**
     * Generate intelligent methods from patterns AND assertion groups
     */
    private generateMethods(
        patterns: Pattern[],
        contexts: Map<Action, ElementContext>,
        assertions: Map<Action, ExtractedAssertion>
    ): MethodDefinition[] {
        const methods: MethodDefinition[] = [];

        // Generate methods from detected patterns (login, search, dropdown, etc.)
        for (const pattern of patterns) {
            // Get context from first non-navigation action in pattern
            const firstAction = pattern.actions.find(a => a.type !== 'navigation');
            if (!firstAction) continue;

            const context = contexts.get(firstAction);
            if (!context) continue;

            // Filter out cross-module actions (navigation to different pages)
            const coreActions = this.filterCorePatternActions(pattern.actions, context.pageModule, contexts);

            // Skip if no core actions remain
            if (coreActions.length === 0) continue;

            // Generate method name
            const methodName = this.namingSystem.generateMethodName(pattern, context);

            // Generate Gherkin step
            const gherkinStep = this.namingSystem.generateGherkinStepText(pattern, context);

            // Generate parameters
            const parameters = this.generateMethodParameters(pattern);

            // Create method definition
            const method: MethodDefinition = {
                name: methodName,
                purpose: this.describePatternPurpose(pattern),
                parameters,
                actions: coreActions,
                patterns: [pattern],
                returnType: 'Promise<void>',
                gherkinStep
            };

            methods.push(method);
        }

        // Generate verification methods from assertion groups
        const assertionMethods = this.generateAssertionMethods(assertions, contexts);
        methods.push(...assertionMethods);

        return methods;
    }

    /**
     * Generate verification methods from grouped assertions
     */
    private generateAssertionMethods(
        assertions: Map<Action, ExtractedAssertion>,
        contexts: Map<Action, ElementContext>
    ): MethodDefinition[] {
        const methods: MethodDefinition[] = [];

        // Group assertions by module
        const assertionsByModule = new Map<string, Action[]>();
        for (const [action, assertion] of assertions.entries()) {
            const context = contexts.get(action);
            if (!context) continue;

            const module = context.pageModule;
            if (!assertionsByModule.has(module)) {
                assertionsByModule.set(module, []);
            }
            assertionsByModule.get(module)!.push(action);
        }

        // Create verification method for each module with assertions
        for (const [module, assertionActions] of assertionsByModule.entries()) {
            if (assertionActions.length === 0) continue;

            const methodName = `verify${module}Elements`;
            const purpose = `Verify ${module} page elements are displayed`;

            const method: MethodDefinition = {
                name: methodName,
                purpose,
                parameters: [],
                actions: assertionActions,
                patterns: [],
                returnType: 'Promise<void>',
                gherkinStep: `Then I should see ${module} page elements`
            };

            methods.push(method);
        }

        return methods;
    }

    /**
     * Filter pattern actions to only include core actions for the target module
     * Removes navigation to other pages
     */
    private filterCorePatternActions(actions: Action[], targetModule: string, contexts: Map<Action, ElementContext>): Action[] {
        const coreActions: Action[] = [];

        for (const action of actions) {
            // Skip navigation actions
            if (action.type === 'navigation') continue;

            const context = contexts.get(action);
            if (!context) continue;

            // Include action if it belongs to target module
            if (context.pageModule === targetModule) {
                coreActions.push(action);
            }

            // Stop if we encounter action from different module (indicates page transition)
            if (context.pageModule !== targetModule && action.target?.type === 'getByRole' && action.target.selector === 'link') {
                break;
            }
        }

        return coreActions;
    }

    /**
     * Generate method parameters from pattern
     */
    private generateMethodParameters(pattern: Pattern): ParameterDefinition[] {
        const parameters: ParameterDefinition[] = [];

        switch (pattern.type) {
            case 'dropdown':
                parameters.push({
                    name: 'option',
                    type: 'string',
                    defaultValue: `'${pattern.data.optionText}'`
                });
                break;

            case 'login':
                parameters.push(
                    { name: 'username', type: 'string' },
                    { name: 'password', type: 'string' }
                );
                break;

            case 'search':
                if (pattern.data.searchFields && pattern.data.searchFields.length > 0) {
                    for (const field of pattern.data.searchFields) {
                        const paramName = this.namingSystem.generateParameterName(field.field);
                        parameters.push({
                            name: paramName,
                            type: 'string'
                        });
                    }
                }
                break;

            case 'navigation':
                // No parameters - module is in method name
                break;

            case 'modal':
                // No parameters - action is confirm/cancel
                break;
        }

        return parameters;
    }

    /**
     * Describe pattern purpose
     */
    private describePatternPurpose(pattern: Pattern): string {
        switch (pattern.type) {
            case 'dropdown':
                return `Filter by ${pattern.data.fieldContext.toLowerCase()}`;
            case 'modal':
                return `${pattern.data.action === 'confirm' ? 'Confirm' : 'Cancel'} the operation`;
            case 'login':
                return 'Authenticate user with credentials';
            case 'search':
                return 'Search for records with criteria';
            case 'navigation':
                return `Navigate to ${pattern.data.targetModule} module`;
            default:
                return 'Perform action';
        }
    }

    /**
     * Build final code output from architecture
     */
    private buildCodeOutput(architecture: ArchitectureOutput): GeneratedCSCode {
        // Build Feature files
        const features = architecture.features.map(feature => ({
            fileName: `${this.namingSystem.toKebabCase(feature.name)}.feature`,
            path: `test/features/${this.namingSystem.toKebabCase(feature.name)}.feature`,
            content: this.buildFeatureContent(feature),
            scenarios: feature.scenarios.map((s: any) => ({
                name: s.name,
                tags: s.tags,
                steps: s.steps.map((step: string) => ({
                    keyword: this.extractGherkinKeyword(step),
                    text: this.extractGherkinText(step)
                }))
            }))
        }));

        // Build Page Objects
        const pageObjects = architecture.pageObjects.map((page: any) => ({
            className: page.className,
            fileName: `${page.className}.ts`,
            path: `test/pages/${page.className}.ts`,
            content: this.buildPageObjectContent(page, architecture),
            baseClass: page.extends,
            decorator: '@CSPageObject',
            elements: [],
            methods: []
        }));

        // Build Step Definitions
        const stepDefinitions = architecture.stepDefinitions.map((steps: any) => ({
            className: steps.className,
            fileName: `${steps.className}.ts`,
            path: `test/steps/${steps.className}.ts`,
            content: this.buildStepDefinitionContent(steps, architecture),
            steps: []
        }));

        // Build Navigation Component if exists
        const components: any[] = [];
        if (architecture.navigationComponent) {
            components.push({
                fileName: 'NavigationComponent.ts',
                path: 'test/components/NavigationComponent.ts',
                content: this.buildNavigationComponentContent(architecture.navigationComponent)
            });
        }

        return {
            feature: features[0], // Primary feature
            features,
            pageObjects,
            stepDefinitions,
            components,
            metadata: {
                timestamp: Date.now(),
                version: '2.0.0-intelligent',
                generatedBy: 'IntelligentCodeGenerator',
                intelligence: {
                    patterns: architecture.pageObjects.reduce((sum: number, p: any) => sum + p.methods.length, 0),
                    pages: architecture.pageObjects.length,
                    steps: architecture.stepDefinitions.length,
                    features: architecture.features.length
                }
            }
        };
    }

    /**
     * Extract Gherkin keyword from step text
     */
    private extractGherkinKeyword(step: string): 'Given' | 'When' | 'Then' | 'And' | 'But' {
        const match = step.match(/^(Given|When|Then|And|But)\s/);
        if (match) {
            return match[1] as any;
        }
        return 'When';
    }

    /**
     * Extract Gherkin text (without keyword)
     */
    private extractGherkinText(step: string): string {
        return step.replace(/^(Given|When|Then|And|But)\s+/, '');
    }

    /**
     * Build Feature file content
     */
    private buildFeatureContent(feature: any): string {
        let content = `Feature: ${feature.name}\n`;
        content += `  ${feature.description}\n\n`;

        for (const scenario of feature.scenarios) {
            content += `  ${scenario.tags.join(' ')}\n`;
            content += `  Scenario: ${scenario.name}\n`;

            for (const step of scenario.steps) {
                content += `    ${step}\n`;
            }
            content += `\n`;
        }

        return content;
    }

    /**
     * Build Page Object content - Production quality code generation
     */
    private buildPageObjectContent(page: any, architecture: ArchitectureOutput): string {
        // Proper imports matching production code patterns
        let content = `import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';\n`;
        content += `import { CSWebElement, CSElementFactory } from '@mdakhan.mak/cs-playwright-test-framework/element';\n`;
        content += `import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';\n\n`;

        // Class documentation
        content += `/**\n`;
        content += ` * ${page.className}\n`;
        content += ` * Module: ${page.module}\n`;
        content += ` * Generated by CS Playwright Test Framework\n`;
        content += ` */\n`;

        // Generate @CSPage decorator with kebab-case page identifier
        const pageIdentifier = this.toKebabCase(page.module);
        content += `@CSPage('${pageIdentifier}')\n`;

        content += `export class ${page.className} extends ${page.extends} {\n\n`;

        // Add section header for elements
        content += `    // ===================================================================\n`;
        content += `    // PAGE ELEMENTS\n`;
        content += `    // ===================================================================\n`;

        // Add element declarations with @CSGetElement decorators
        for (const element of page.elements) {
            content += this.buildElementDecorator(element);
        }

        // Add initializeElements method
        content += `\n    protected initializeElements(): void {\n`;
        content += `        CSReporter.debug('${page.className} elements initialized');\n`;
        content += `    }\n\n`;

        // Add section header for methods
        content += `    // ===================================================================\n`;
        content += `    // PAGE METHODS - Using Framework Wrapper Methods\n`;
        content += `    // ===================================================================\n\n`;

        // Add methods
        for (const method of page.methods) {
            content += this.buildMethodImplementation(method, page.elements);
            content += `\n`;
        }

        content += `}\n\n`;
        content += `export default ${page.className};\n`;

        return content;
    }

    /**
     * Convert string to kebab-case
     */
    private toKebabCase(str: string): string {
        return str
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .replace(/[\s_]+/g, '-')
            .toLowerCase();
    }

    /**
     * Build @CSGetElement decorator for element - Production quality
     */
    private buildElementDecorator(element: ElementDefinition): string {
        // Generate semantic description from element name
        const desc = element.name
            .replace(/([A-Z])/g, ' $1')
            .trim()
            .toLowerCase()
            .replace(/^\s+/, '');

        let content = `\n    @CSGetElement({\n`;

        // Build primary locator (prefer xpath for reliability)
        const locator = this.buildDecoratorLocator(element);
        content += locator;

        // Add description
        content += `,\n        description: '${this.escapeString(desc)}'`;

        // Add options
        content += `,\n        waitForVisible: true`;
        content += `,\n        selfHeal: true`;

        // Generate alternative locators for self-healing
        const altLocators = this.generateAlternativeLocators(element);
        if (altLocators.length > 0) {
            content += `,\n        alternativeLocators: [${altLocators.map(loc => `'${this.escapeString(loc)}'`).join(', ')}]`;
        }

        content += `\n    })\n`;
        content += `    public ${element.name}!: CSWebElement;\n`;

        return content;
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
     * Build primary locator for decorator - Use XPath for reliability
     */
    private buildDecoratorLocator(element: ElementDefinition): string {
        switch (element.locatorType) {
            case 'getByRole':
                // Use XPath for role-based selectors (more reliable than CSS)
                if (element.options?.name) {
                    const escapedName = this.escapeString(element.options.name);
                    return `        xpath: '//*[@role="${element.selector}"][normalize-space(.)="${escapedName}" or @aria-label="${escapedName}" or @name="${escapedName}"]'`;
                }
                return `        xpath: '//*[@role="${element.selector}"]'`;

            case 'getByText':
                // Use XPath for text matching
                const text = this.escapeString(element.options?.name || element.selector);
                return `        xpath: '//*[contains(text(), "${text}")]'`;

            case 'getByTestId':
                return `        css: '[data-testid="${element.selector}"]'`;

            case 'getByPlaceholder':
                const placeholder = this.escapeString(element.options?.name || element.selector);
                return `        xpath: '//input[@placeholder="${placeholder}"]'`;

            case 'getByLabel':
                const label = this.escapeString(element.options?.name || element.selector);
                return `        xpath: '//label[contains(text(), "${label}")]/following::input[1] | //input[@aria-label="${label}"]'`;

            case 'locator':
                if (element.selector.startsWith('//') || element.selector.startsWith('(//')) {
                    return `        xpath: '${this.escapeString(element.selector)}'`;
                } else {
                    return `        css: '${this.escapeString(element.selector)}'`;
                }

            default:
                return `        css: '${this.escapeString(element.selector)}'`;
        }
    }

    /**
     * Generate alternative locators for self-healing
     */
    private generateAlternativeLocators(element: ElementDefinition): string[] {
        const alternatives: string[] = [];

        switch (element.locatorType) {
            case 'getByRole':
                // Add CSS alternative
                if (element.options?.name) {
                    alternatives.push(`css:[role="${element.selector}"][aria-label="${element.options.name}"]`);
                    // Add text-based alternative
                    alternatives.push(`xpath://*[@role="${element.selector}"][contains(text(), "${element.options.name}")]`);
                } else {
                    alternatives.push(`css:[role="${element.selector}"]`);
                }
                break;

            case 'getByText':
                const text = element.options?.name || element.selector;
                // Add CSS text alternative
                alternatives.push(`css:*:has-text("${text}")`);
                break;

            case 'getByTestId':
                // Add data attribute alternatives
                alternatives.push(`xpath://*[@data-testid="${element.selector}"]`);
                break;

            case 'getByPlaceholder':
                const placeholder = element.options?.name || element.selector;
                alternatives.push(`css:input[placeholder="${placeholder}"]`);
                break;

            case 'locator':
                if (element.selector.startsWith('//')) {
                    // XPath - try to generate CSS alternative
                    const cssHint = this.xpathToCssHint(element.selector);
                    if (cssHint) {
                        alternatives.push(`css:${cssHint}`);
                    }
                } else {
                    // CSS - add XPath alternative
                    const xpathHint = this.cssToXpathHint(element.selector);
                    if (xpathHint) {
                        alternatives.push(`xpath:${xpathHint}`);
                    }
                }
                break;
        }

        return alternatives;
    }

    /**
     * Try to convert XPath to CSS hint
     */
    private xpathToCssHint(xpath: string): string | null {
        // Extract id from XPath
        const idMatch = xpath.match(/@id=['"]([^'"]+)['"]/);
        if (idMatch) {
            return `#${idMatch[1]}`;
        }

        // Extract class from XPath
        const classMatch = xpath.match(/contains\(@class,\s*['"]([^'"]+)['"]\)/);
        if (classMatch) {
            return `.${classMatch[1]}`;
        }

        // Extract role from XPath
        const roleMatch = xpath.match(/@role=['"]([^'"]+)['"]/);
        if (roleMatch) {
            return `[role="${roleMatch[1]}"]`;
        }

        return null;
    }

    /**
     * Try to convert CSS to XPath hint
     */
    private cssToXpathHint(css: string): string | null {
        // Handle ID selector
        if (css.startsWith('#')) {
            return `//*[@id="${css.substring(1)}"]`;
        }

        // Handle class selector
        if (css.startsWith('.')) {
            return `//*[contains(@class, "${css.substring(1)}")]`;
        }

        // Handle attribute selector
        const attrMatch = css.match(/\[([^=]+)=['"]([^'"]+)['"]\]/);
        if (attrMatch) {
            return `//*[@${attrMatch[1]}="${attrMatch[2]}"]`;
        }

        return null;
    }


    /**
     * Build CS Framework locator
     */
    private buildCSLocator(element: ElementDefinition): string {
        switch (element.locatorType) {
            case 'getByRole':
                const role = element.selector;
                const name = element.options?.name;
                if (name) {
                    return `{ role: '${role}', name: '${name}' }`;
                }
                return `{ role: '${role}' }`;

            case 'getByText':
                const text = element.options?.name || element.selector;
                return `{ text: '${text}' }`;

            case 'locator':
                return `{ css: '${element.selector}' }`;

            default:
                return `{ css: '${element.selector}' }`;
        }
    }

    /**
     * Build method implementation with framework wrapper methods
     */
    private buildMethodImplementation(method: MethodDefinition, elements: ElementDefinition[]): string {
        const params = method.parameters.map((p: any) => `${p.name}: ${p.type}`).join(', ');
        const hasParams = method.parameters.length > 0;
        const paramStr = hasParams ? ` - ${method.parameters.map(p => `\${${p.name}}`).join(', ')}` : '';

        let code = `    /**\n`;
        code += `     * ${method.purpose}\n`;
        if (method.gherkinStep) {
            code += `     * Gherkin: ${method.gherkinStep}\n`;
        }
        code += `     */\n`;
        code += `    public async ${method.name}(${params}): ${method.returnType} {\n`;
        code += `        CSReporter.info(\`${this.escapeString(method.purpose)}${paramStr}\`);\n\n`;

        // Generate implementation from actions using framework wrapper methods
        for (const action of method.actions) {
            const lines = this.buildActionImplementation(action, elements, method.parameters);
            if (lines) {
                // Split multi-line implementations
                const lineArray = lines.split('\n').filter(l => l.trim());
                for (const line of lineArray) {
                    code += `        ${line}\n`;
                }
            }
        }

        // Add success reporter at the end
        code += `\n        CSReporter.pass('${this.escapeString(this.generateSuccessMessage(method))}');\n`;
        code += `    }\n`;

        return code;
    }

    /**
     * Generate success message for CSReporter.pass()
     */
    private generateSuccessMessage(method: MethodDefinition): string {
        if (method.name.startsWith('verify')) {
            return `Verification successful`;
        } else if (method.name.includes('login') || method.name.includes('Login')) {
            return `Login completed successfully`;
        } else if (method.name.includes('search') || method.name.includes('Search')) {
            return `Search completed successfully`;
        } else {
            return `${method.purpose} completed successfully`;
        }
    }

    /**
     * Build action implementation using framework wrapper methods
     */
    private buildActionImplementation(action: Action, elements: ElementDefinition[], parameters: ParameterDefinition[]): string {
        // Skip navigation actions
        if (action.type === 'navigation') return '';

        // Skip navigation link clicks (Admin, PIM, Time, etc.)
        if (action.type === 'click' && action.target?.type === 'getByRole' && action.target.selector === 'link') {
            const linkName = action.target.options?.name || '';
            const navigationModules = ['Admin', 'PIM', 'Leave', 'Time', 'Recruitment',
                                       'Performance', 'Dashboard', 'Directory', 'Maintenance'];
            if (navigationModules.some(m => linkName.includes(m))) {
                return ''; // Skip navigation link - should be handled by NavigationComponent
            }
        }

        // Find element for this action by matching selector AND locator type
        const element = elements.find(e => {
            if (!action.target) return false;

            // Match by both selector and type for better accuracy
            const selectorMatch = e.selector === action.target.selector;
            const typeMatch = e.locatorType === action.target.type;

            // For getByRole, also match the name option
            if (action.target.type === 'getByRole' && action.target.options?.name) {
                const nameMatch = e.options?.name === action.target.options.name;
                return selectorMatch && typeMatch && nameMatch;
            }

            return selectorMatch && typeMatch;
        });

        // If no element found, use CSElementFactory for dynamic element
        let elementRef = '';
        let isInlineElement = false;
        if (element) {
            elementRef = `this.${element.name}`;
        } else if (action.target) {
            // Generate CSElementFactory for unmatched elements
            elementRef = this.buildDynamicElementFactory(action.target);
            isInlineElement = true;
        } else {
            return ''; // Skip actions without targets
        }

        switch (action.type) {
            case 'click':
                // Use framework wrapper methods with waitForVisible
                if (isInlineElement) {
                    return `const clickElement = ${elementRef};\nawait clickElement.waitForVisible(10000);\nawait clickElement.clickWithTimeout(10000);\nawait this.waitForPageLoad();`;
                }
                return `await ${elementRef}.waitForVisible(10000);\nawait ${elementRef}.clickWithTimeout(10000);\nawait this.waitForPageLoad();`;

            case 'fill':
                const value = action.args[0];
                // Check if this matches a parameter name
                const matchingParam = this.findMatchingParameter(action, parameters);
                const fillValue = matchingParam ? matchingParam.name : (typeof value === 'string' ? `'${this.escapeString(value)}'` : `String(${value})`);

                if (isInlineElement) {
                    return `const fillElement = ${elementRef};\nawait fillElement.waitForVisible(10000);\nawait fillElement.fillWithTimeout(${fillValue}, 10000);`;
                }
                return `await ${elementRef}.waitForVisible(10000);\nawait ${elementRef}.fillWithTimeout(${fillValue}, 10000);`;

            case 'assertion':
                // Generate proper verification with pass/fail pattern
                if (action.expression.includes('toBeVisible')) {
                    if (isInlineElement) {
                        return `const verifyElement = ${elementRef};\nconst isVisible = await verifyElement.isVisibleWithTimeout(10000);\nif (isVisible) {\n    CSReporter.pass('Element is visible');\n} else {\n    CSReporter.fail('Element is not visible');\n    throw new Error('Element visibility verification failed');\n}`;
                    }
                    return `const isVisible = await ${elementRef}.isVisibleWithTimeout(10000);\nif (isVisible) {\n    CSReporter.pass('Element is visible');\n} else {\n    CSReporter.fail('Element is not visible');\n    throw new Error('Element visibility verification failed');\n}`;
                } else if (action.expression.includes('toContainText')) {
                    // Extract text from expression
                    const match = action.expression.match(/toContainText\(['"]([^'"]+)['"]\)/);
                    const expectedText = match ? `'${this.escapeString(match[1])}'` : "'expected text'";

                    if (isInlineElement) {
                        return `const textElement = ${elementRef};\nawait textElement.waitForVisible(10000);\nconst actualText = await textElement.textContentWithTimeout(5000);\nif (actualText?.includes(${expectedText})) {\n    CSReporter.pass(\`Element contains expected text: \${${expectedText}}\`);\n} else {\n    CSReporter.fail(\`Element does not contain expected text. Expected: \${${expectedText}}, Actual: \${actualText}\`);\n    throw new Error('Text verification failed');\n}`;
                    }
                    return `await ${elementRef}.waitForVisible(10000);\nconst actualText = await ${elementRef}.textContentWithTimeout(5000);\nif (actualText?.includes(${expectedText})) {\n    CSReporter.pass(\`Element contains expected text: \${${expectedText}}\`);\n} else {\n    CSReporter.fail(\`Element does not contain expected text. Expected: \${${expectedText}}, Actual: \${actualText}\`);\n    throw new Error('Text verification failed');\n}`;
                }
                // Default visibility check
                return `const isVisible = await ${elementRef}.isVisibleWithTimeout(10000);\nif (!isVisible) {\n    throw new Error('Element not visible');\n}`;

            default:
                return '';
        }
    }

    /**
     * Build CSElementFactory for dynamic elements
     */
    private buildDynamicElementFactory(target: any): string {
        switch (target.type) {
            case 'getByRole':
                if (target.options?.name) {
                    const escapedName = this.escapeString(target.options.name);
                    return `CSElementFactory.createByXPath(\n            '//*[@role="${target.selector}"][normalize-space(.)="${escapedName}" or @aria-label="${escapedName}"]',\n            '${target.selector} element: ${escapedName}',\n            this.page\n        )`;
                }
                return `CSElementFactory.createByXPath(\n            '//*[@role="${target.selector}"]',\n            '${target.selector} element',\n            this.page\n        )`;

            case 'getByText':
                const text = this.escapeString(target.selector);
                return `CSElementFactory.createByXPath(\n            '//*[contains(text(), "${text}")]',\n            'Text element: ${text}',\n            this.page\n        )`;

            case 'locator':
                if (target.selector.startsWith('//')) {
                    return `CSElementFactory.createByXPath(\n            '${this.escapeString(target.selector)}',\n            'XPath element',\n            this.page\n        )`;
                } else {
                    return `CSElementFactory.createByCss(\n            '${this.escapeString(target.selector)}',\n            'CSS element',\n            this.page\n        )`;
                }

            default:
                return `CSElementFactory.createByCss(\n            '${this.escapeString(target.selector)}',\n            'Element',\n            this.page\n        )`;
        }
    }

    /**
     * Find matching parameter for a fill action
     */
    private findMatchingParameter(action: Action, parameters: ParameterDefinition[]): ParameterDefinition | null {
        if (action.type !== 'fill' || !action.target) return null;

        // Check if target field matches a parameter name
        const fieldName = action.target.options?.name?.toLowerCase() || '';

        for (const param of parameters) {
            // Match parameter name with field name
            if (fieldName.includes(param.name.toLowerCase())) {
                return param;
            }
            // Also check reverse
            if (param.name.toLowerCase().includes(fieldName)) {
                return param;
            }
        }

        return null;
    }

    /**
     * Build inline locator for elements not in page object (NO await here!)
     */
    private buildInlineLocator(target: any): string {
        switch (target.type) {
            case 'getByRole':
                if (target.options?.name) {
                    return `this.page.getByRole('${target.selector}', { name: '${target.options.name}' })`;
                }
                return `this.page.getByRole('${target.selector}')`;

            case 'getByText':
                return `this.page.getByText('${target.selector}')`;

            case 'locator':
                return `this.page.locator('${target.selector}')`;

            default:
                return `this.page.locator('${target.selector}')`;
        }
    }

    /**
     * Build Step Definition content - Production quality with Cucumber expressions
     */
    private buildStepDefinitionContent(steps: any, architecture: ArchitectureOutput): string {
        // Proper imports matching production code patterns
        let content = `import {\n`;
        content += `    CSBDDStepDef, Page, StepDefinitions,\n`;
        content += `    CSScenarioContext, CSFeatureContext, CSBDDContext\n`;
        content += `} from '@mdakhan.mak/cs-playwright-test-framework/bdd';\n`;
        content += `import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';\n`;

        // Import required page objects
        const requiredPages = architecture.pageObjects.filter((p: any) =>
            p.module === steps.module || steps.module === 'Navigation'
        );

        for (const page of requiredPages) {
            content += `import { ${page.className} } from '../pages/${page.className}';\n`;
        }

        content += `\n`;
        content += `/**\n`;
        content += ` * ${steps.className}\n`;
        content += ` * Module: ${steps.module}\n`;
        content += ` * Generated by CS Playwright Test Framework\n`;
        content += ` */\n`;
        content += `@StepDefinitions\n`;
        content += `export class ${steps.className} {\n\n`;

        // Add page injections using @Page decorator with kebab-case identifier
        for (const page of requiredPages) {
            const pageIdentifier = this.toKebabCase(page.module);
            const varName = page.className.charAt(0).toLowerCase() + page.className.slice(1);
            content += `    @Page('${pageIdentifier}')\n`;
            content += `    private ${varName}!: ${page.className};\n\n`;
        }

        // Add context instances
        content += `    private scenarioContext = CSScenarioContext.getInstance();\n`;
        content += `    private featureContext = CSFeatureContext.getInstance();\n`;
        content += `    private bddContext = CSBDDContext.getInstance();\n\n`;

        // Add section header
        content += `    // ===================================================================\n`;
        content += `    // STEP DEFINITIONS - Using Cucumber Expressions\n`;
        content += `    // ===================================================================\n\n`;

        // Add step methods with @CSBDDStepDef decorator using Cucumber expressions (NOT regex!)
        for (const method of steps.methods) {
            const gherkinStep = method.gherkinStep || method.decoratorPattern || '';
            const stepText = this.extractGherkinText(gherkinStep);

            // Convert to Cucumber expression pattern (replace quoted strings with {string})
            const cucumberPattern = stepText.replace(/"([^"]+)"/g, '{string}');

            // Generate unique step method name to avoid collision with page method
            const stepMethodName = `step${this.toPascalCase(method.methodName)}`;

            content += `    /**\n`;
            content += `     * Step: ${stepText}\n`;
            content += `     */\n`;
            content += `    @CSBDDStepDef('${this.escapeString(cucumberPattern)}')\n`;

            const params = method.parameters.map((p: any) => `${p.name}: ${p.type}`).join(', ');
            const paramNames = method.parameters.map((p: any) => p.name).join(', ');

            content += `    async ${stepMethodName}(${params}): Promise<void> {\n`;
            content += `        CSReporter.info('Executing step: ${this.escapeString(stepText)}');\n\n`;

            // Call page object method (NOT recursive step call!)
            if (requiredPages.length > 0) {
                const pageName = requiredPages[0].className;
                const pageVarName = pageName.charAt(0).toLowerCase() + pageName.slice(1);
                content += `        // Call page object method to perform the action\n`;
                content += `        await this.${pageVarName}.${method.methodName}(${paramNames});\n\n`;
            } else {
                // If no page, include implementation directly
                content += `        ${method.implementation || '// TODO: Add implementation'}\n\n`;
            }

            content += `        CSReporter.pass('Step completed: ${this.escapeString(stepText)}');\n`;
            content += `    }\n\n`;
        }

        content += `}\n\n`;
        content += `export default ${steps.className};\n`;

        return content;
    }

    /**
     * Convert string to PascalCase
     */
    private toPascalCase(str: string): string {
        return str
            .split(/[\s\-_]+/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('');
    }

    /**
     * Build Navigation Component content - Production quality
     */
    private buildNavigationComponentContent(component: any): string {
        let content = `import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';\n`;
        content += `import { CSWebElement, CSElementFactory } from '@mdakhan.mak/cs-playwright-test-framework/element';\n`;
        content += `import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporter';\n\n`;

        content += `/**\n`;
        content += ` * Navigation Component\n`;
        content += ` * Handles main navigation menu interactions\n`;
        content += ` * Generated by CS Playwright Test Framework\n`;
        content += ` */\n`;
        content += `@CSPage('navigation')\n`;
        content += `export class NavigationComponent extends CSBasePage {\n\n`;

        content += `    // ===================================================================\n`;
        content += `    // NAVIGATION ELEMENTS\n`;
        content += `    // ===================================================================\n\n`;

        // Add navigation links with proper decorators
        for (const element of component.elements) {
            const desc = element.name.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
            content += `    @CSGetElement({\n`;
            content += `        xpath: '//nav//a[contains(text(), "${element.name.replace('Link', '')}")]',\n`;
            content += `        description: '${desc}',\n`;
            content += `        waitForVisible: true,\n`;
            content += `        selfHeal: true\n`;
            content += `    })\n`;
            content += `    public ${element.name}!: CSWebElement;\n\n`;
        }

        content += `    protected initializeElements(): void {\n`;
        content += `        CSReporter.debug('NavigationComponent elements initialized');\n`;
        content += `    }\n\n`;

        content += `    // ===================================================================\n`;
        content += `    // NAVIGATION METHODS\n`;
        content += `    // ===================================================================\n\n`;

        content += `    /**\n`;
        content += `     * Navigate to a module in the application\n`;
        content += `     * @param moduleName - The name of the module to navigate to\n`;
        content += `     */\n`;
        content += `    public async navigateToModule(moduleName: string): Promise<void> {\n`;
        content += `        CSReporter.info(\`Navigating to \${moduleName}\`);\n\n`;
        content += `        // Use CSElementFactory for dynamic menu item\n`;
        content += `        const menuItem = CSElementFactory.createByXPath(\n`;
        content += `            \`//nav//a[contains(text(), '\${moduleName}')]\`,\n`;
        content += `            \`Menu item: \${moduleName}\`,\n`;
        content += `            this.page\n`;
        content += `        );\n\n`;
        content += `        await menuItem.waitForVisible(10000);\n`;
        content += `        await menuItem.clickWithTimeout(10000);\n`;
        content += `        await this.waitForPageLoad();\n\n`;
        content += `        CSReporter.pass(\`Navigated to \${moduleName}\`);\n`;
        content += `    }\n\n`;

        content += `    /**\n`;
        content += `     * Verify a menu item is visible\n`;
        content += `     * @param menuItemName - The name of the menu item to verify\n`;
        content += `     */\n`;
        content += `    public async verifyMenuItemVisible(menuItemName: string): Promise<void> {\n`;
        content += `        CSReporter.info(\`Verifying menu item visible: \${menuItemName}\`);\n\n`;
        content += `        const menuItem = CSElementFactory.createByXPath(\n`;
        content += `            \`//nav//a[contains(text(), '\${menuItemName}')]\`,\n`;
        content += `            \`Menu item: \${menuItemName}\`,\n`;
        content += `            this.page\n`;
        content += `        );\n\n`;
        content += `        const isVisible = await menuItem.isVisibleWithTimeout(10000);\n\n`;
        content += `        if (isVisible) {\n`;
        content += `            CSReporter.pass(\`Menu item verified: \${menuItemName}\`);\n`;
        content += `        } else {\n`;
        content += `            CSReporter.fail(\`Menu item not found: \${menuItemName}\`);\n`;
        content += `            throw new Error(\`Menu item verification failed: \${menuItemName}\`);\n`;
        content += `        }\n`;
        content += `    }\n`;

        content += `}\n\n`;
        content += `export default NavigationComponent;\n`;

        return content;
    }
}
