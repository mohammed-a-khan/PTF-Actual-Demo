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
     * Build Page Object content - USING REAL DEMO PATTERN WITH DECORATORS!
     */
    private buildPageObjectContent(page: any, architecture: ArchitectureOutput): string {
        const hasAssertions = page.methods.some((m: MethodDefinition) =>
            m.actions.some((a: Action) => a.type === 'assertion')
        );

        // Import decorators and required classes
        let content = `import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';\n`;
        content += `import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';\n`;
        content += `import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';\n`;

        if (hasAssertions) {
            content += `import { CSExpect } from '@mdakhan.mak/cs-playwright-test-framework/assertions';\n`;
        }

        content += `\n`;

        // Generate @CSPage decorator with page identifier
        const pageIdentifier = page.module.toLowerCase().replace(/\s+/g, '-');
        content += `@CSPage('${pageIdentifier}')\n`;

        content += `export class ${page.className} extends ${page.extends} {\n`;

        // Add element declarations with @CSGetElement decorators
        for (const element of page.elements) {
            content += this.buildElementDecorator(element);
        }

        // Add initializeElements method
        content += `\n    protected initializeElements(): void {\n`;
        content += `        CSReporter.debug('${page.className} elements initialized');\n`;
        content += `    }\n\n`;

        // Add methods
        for (const method of page.methods) {
            content += this.buildMethodImplementation(method, page.elements);
            content += `\n`;
        }

        content += `}\n`;

        return content;
    }

    /**
     * Build @CSGetElement decorator for element
     */
    private buildElementDecorator(element: ElementDefinition): string {
        const desc = element.name.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
        let content = `\n    // ${desc}\n`;
        content += `    @CSGetElement({\n`;

        // Build primary locator
        content += this.buildDecoratorLocator(element);

        // Add description
        content += `,\n        description: '${desc}'`;

        // Add options
        content += `,\n        waitForVisible: true`;
        content += `,\n        selfHeal: true`;

        // Generate alternative locators
        const altLocators = this.generateAlternativeLocators(element);
        if (altLocators.length > 0) {
            content += `,\n        alternativeLocators: [\n`;
            content += altLocators.map(loc => `            '${loc}'`).join(',\n');
            content += `\n        ]`;
        }

        content += `\n    })\n`;
        content += `    public ${element.name}!: CSWebElement;\n`;

        return content;
    }

    /**
     * Build primary locator for decorator
     */
    private buildDecoratorLocator(element: ElementDefinition): string {
        switch (element.locatorType) {
            case 'getByRole':
                if (element.options?.name) {
                    return `        css: 'role=${element.selector}[name="${element.options.name}"]'`;
                }
                return `        css: 'role=${element.selector}'`;

            case 'getByText':
                return `        text: '${element.options?.name || element.selector}'`;

            case 'getByTestId':
                return `        css: '[data-testid="${element.selector}"]'`;

            case 'locator':
                if (element.selector.startsWith('//')) {
                    return `        xpath: '${element.selector}'`;
                } else {
                    return `        css: '${element.selector}'`;
                }

            default:
                return `        css: '${element.selector}'`;
        }
    }

    /**
     * Generate alternative locators for element
     */
    private generateAlternativeLocators(element: ElementDefinition): string[] {
        const alternatives: string[] = [];

        switch (element.locatorType) {
            case 'getByRole':
                if (element.options?.name) {
                    alternatives.push(`xpath://*[@role="${element.selector}" and @name="${element.options.name}"]`);
                }
                break;

            case 'getByText':
                const text = element.options?.name || element.selector;
                alternatives.push(`css:*:has-text("${text}")`);
                alternatives.push(`xpath://*[contains(text(),"${text}")]`);
                break;

            case 'locator':
                if (element.selector.startsWith('//')) {
                    // XPath - add CSS alternative if possible
                    alternatives.push(`css:${element.selector}`);
                } else {
                    // CSS - add XPath alternative
                    alternatives.push(`xpath://*[contains(@class,"${element.selector.replace('.', '')}")]`);
                }
                break;
        }

        return alternatives;
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
     * Build method implementation with CSReporter pattern from demo project
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
        code += `        CSReporter.info(\`${method.purpose}${paramStr}\`);\n\n`;

        // Generate implementation from actions
        for (const action of method.actions) {
            const line = this.buildActionImplementation(action, elements, method.parameters);
            if (line) {
                code += `        ${line}\n`;
            }
        }

        // Add success reporter at the end (demo project pattern)
        code += `\n        CSReporter.pass('${this.generateSuccessMessage(method)}');\n`;
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
     * Build action implementation line
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

        // If no element found, create inline locator
        let elementRef = '';
        if (element) {
            elementRef = `this.${element.name}`;
        } else if (action.target) {
            // Generate inline locator for unmatched elements
            elementRef = this.buildInlineLocator(action.target);
        } else {
            return ''; // Skip actions without targets
        }

        switch (action.type) {
            case 'click':
                return `await ${elementRef}.click();`;

            case 'fill':
                const value = action.args[0];
                if (typeof value === 'string') {
                    // Check if this matches a parameter name
                    const matchingParam = this.findMatchingParameter(action, parameters);
                    if (matchingParam) {
                        return `await ${elementRef}.fill(${matchingParam.name});`;
                    }
                    // Otherwise hardcode the value
                    return `await ${elementRef}.fill('${value}');`;
                }
                return `await ${elementRef}.fill(String(${value}));`;

            case 'assertion':
                // Generate proper assertion based on expression
                if (action.expression.includes('toBeVisible')) {
                    return `await CSExpect(${elementRef}).toBeVisible();`;
                } else if (action.expression.includes('toContainText')) {
                    // Extract text from expression
                    const match = action.expression.match(/toContainText\(['"]([^'"]+)['"]\)/);
                    if (match) {
                        return `await CSExpect(${elementRef}).toContainText('${match[1]}');`;
                    }
                }
                return `await CSExpect(${elementRef}).toBeVisible();`;

            default:
                return '';
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
     * Build Step Definition content
     */
    /**
     * Build Step Definition content using REAL demo project patterns
     */
    private buildStepDefinitionContent(steps: any, architecture: ArchitectureOutput): string {
        // Import decorators (REAL demo pattern - @CSBDDStepDef only!)
        let content = `import {\n`;
        content += `    CSBDDStepDef, Page, StepDefinitions,\n`;
        content += `    CSScenarioContext, CSFeatureContext, CSBDDContext\n`;
        content += `} from '@mdakhan.mak/cs-playwright-test-framework/bdd';\n`;
        content += `import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';\n`;

        // Import required page objects (for type references only, actual injection via @Page)
        const requiredPages = architecture.pageObjects.filter((p: any) =>
            p.module === steps.module || steps.module === 'Navigation'
        );

        for (const page of requiredPages) {
            content += `import { ${page.className} } from '../pages/${page.className}';\n`;
        }

        content += `\n`;
        content += `/**\n`;
        content += ` * Step Definitions: ${steps.className}\n`;
        content += ` * Module: ${steps.module}\n`;
        content += ` */\n`;
        content += `@StepDefinitions\n`;
        content += `export class ${steps.className} {\n\n`;

        // Add page injections using @Page decorator
        for (const page of requiredPages) {
            const pageIdentifier = page.module.toLowerCase().replace(/\s+/g, '-');
            const varName = page.className.charAt(0).toLowerCase() + page.className.slice(1);
            content += `    @Page('${pageIdentifier}')\n`;
            content += `    private ${varName}!: ${page.className};\n\n`;
        }

        // Add context instances (demo project pattern)
        content += `    private scenarioContext = CSScenarioContext.getInstance();\n`;
        content += `    private featureContext = CSFeatureContext.getInstance();\n`;
        content += `    private bddContext = CSBDDContext.getInstance();\n\n`;

        // Add step methods with @CSBDDStepDef decorator (REAL demo pattern!)
        for (const method of steps.methods) {
            const gherkinStep = method.gherkinStep || method.decoratorPattern;
            const stepText = this.extractGherkinText(gherkinStep);

            // Use @CSBDDStepDef with simple string pattern (NOT regex!)
            content += `    @CSBDDStepDef('${stepText}')\n`;

            const params = method.parameters.map((p: any) => `${p.name}: ${p.type}`).join(', ');
            content += `    async ${method.methodName}(${params}) {\n`;
            content += `        CSReporter.info(\`${stepText}\`);\n`;
            content += `        ${method.implementation}\n`;
            content += `        CSReporter.pass(\`Step completed: ${stepText}\`);\n`;
            content += `    }\n\n`;
        }

        content += `}\n\n`;
        content += `export default ${steps.className};\n`;

        return content;
    }

    /**
     * Build Navigation Component content
     */
    private buildNavigationComponentContent(component: any): string {
        let content = `import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';\n`;
        content += `import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';\n\n`;

        content += `/**\n`;
        content += ` * Shared Navigation Component\n`;
        content += ` * Contains all navigation links used across pages\n`;
        content += ` */\n`;
        content += `export class NavigationComponent {\n\n`;

        // Add navigation links
        for (const element of component.elements) {
            content += `    public ${element.name}!: CSWebElement;\n`;
        }

        content += `\n`;
        content += `    /**\n`;
        content += `     * Navigate to a module in the application\n`;
        content += `     */\n`;
        content += `    public async navigateToModule(module: string): Promise<void> {\n`;
        content += `        CSReporter.info(\`Navigating to \${module}\`);\n`;
        content += `        const link = this[\`\${module.toLowerCase()}Link\`];\n`;
        content += `        if (link) {\n`;
        content += `            await link.click();\n`;
        content += `        }\n`;
        content += `    }\n`;
        content += `}\n`;

        return content;
    }
}
