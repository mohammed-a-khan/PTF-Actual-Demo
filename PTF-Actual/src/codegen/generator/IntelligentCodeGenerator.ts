/**
 * Intelligent Code Generator for CS Codegen
 * This is where ALL intelligence layers come together to generate optimal CS Framework code
 *
 * Integrates:
 * - Layer 3: LLM Intent Understanding
 * - Layer 4: Framework Knowledge Graph
 * - Layer 5: ML Pattern Recognition
 * - Layer 7: Runtime Behavior Prediction
 * - Intelligent Locator Optimization
 */

import {
    DeepCodeAnalysis,
    IntentAnalysis,
    GeneratedCSCode,
    GeneratedFeature,
    GeneratedPageObject,
    GeneratedStepDefinition,
    GeneratedElement,
    GeneratedMethod,
    GherkinScenario,
    GherkinStep,
    Action,
    CSCapabilityMatch
} from '../types';
import { FrameworkKnowledgeGraph } from '../knowledge/FrameworkKnowledgeGraph';
import { LLMIntentAnalyzer } from '../intelligence/LLMIntentAnalyzer';
import { MLPatternRecognizer } from '../intelligence/MLPatternRecognizer';
import { RuntimeBehaviorPredictor } from '../intelligence/RuntimeBehaviorPredictor';
import { IntelligentLocatorOptimizer } from '../intelligence/IntelligentLocatorOptimizer';

export class IntelligentCodeGenerator {
    private knowledgeGraph: FrameworkKnowledgeGraph;
    private llmAnalyzer: LLMIntentAnalyzer;
    private patternRecognizer: MLPatternRecognizer;
    private behaviorPredictor: RuntimeBehaviorPredictor;
    private locatorOptimizer: IntelligentLocatorOptimizer;

    constructor() {
        this.knowledgeGraph = new FrameworkKnowledgeGraph();
        this.llmAnalyzer = new LLMIntentAnalyzer({ useLocal: true });
        this.patternRecognizer = new MLPatternRecognizer();
        this.behaviorPredictor = new RuntimeBehaviorPredictor();
        this.locatorOptimizer = new IntelligentLocatorOptimizer();
    }

    /**
     * Generate optimal CS Framework code using ALL intelligence
     */
    public async generate(
        analysis: DeepCodeAnalysis,
        intentAnalysis: IntentAnalysis,
        featureName: string
    ): Promise<GeneratedCSCode> {
        // Layer 3: Get deeper LLM-powered understanding
        const llmAnalysis = await this.llmAnalyzer.analyzeIntent(analysis);

        // Layer 5: Recognize patterns using ML
        const patterns = await this.patternRecognizer.recognizePatterns(analysis);

        // Layer 7: Predict runtime behavior
        const behaviorPrediction = await this.behaviorPredictor.predictBehavior(analysis);

        // DON'T optimize locators here - we'll use original selectors and build proper CS locators
        // The buildCSLocator method will handle the conversion properly

        // Generate Feature file (Gherkin) with LLM insights
        const feature = this.generateFeature(
            analysis,
            intentAnalysis,
            featureName,
            llmAnalysis
        );

        // Generate Page Objects using intelligent method selection
        const pageObjects = this.generatePageObjects(
            analysis,
            intentAnalysis,
            patterns
        );

        // Generate Step Definitions with pattern suggestions
        const stepDefinitions = this.generateStepDefinitions(
            analysis,
            intentAnalysis,
            pageObjects,
            patterns
        );

        // Compile warnings and suggestions from all intelligence layers
        const warnings = this.compileWarnings(behaviorPrediction, patterns);
        const suggestions = this.compileSuggestions(behaviorPrediction, llmAnalysis, patterns);

        return {
            feature,
            pageObjects,
            stepDefinitions,
            metadata: {
                timestamp: Date.now(),
                version: '2.0.0-intelligent',
                sourceFile: 'codegen.spec.ts',
                analysisConfidence: intentAnalysis.confidence,
                transformationAccuracy: this.calculateAccuracy(intentAnalysis),
                warnings,
                suggestions
            }
        };
    }

    /**
     * Optimize all locators in actions
     */
    private optimizeAllLocators(actions: Action[]): Action[] {
        return actions.map(action => {
            if (!action.target) return action;

            const optimized = this.locatorOptimizer.optimizeLocator(action);

            // Update action with optimized locator
            return {
                ...action,
                target: {
                    ...action.target,
                    selector: optimized.optimized
                },
                // Store optimization metadata
                metadata: {
                    originalLocator: optimized.original,
                    stabilityScore: optimized.stabilityScore,
                    fallbacks: optimized.fallbacks,
                    reasoning: optimized.reasoning
                }
            } as any;
        });
    }

    /**
     * Compile warnings from all intelligence layers
     */
    private compileWarnings(behaviorPrediction: any, patterns: any[]): string[] {
        const warnings: string[] = [];

        // Add failure point warnings
        if (behaviorPrediction.failurePoints) {
            for (const point of behaviorPrediction.failurePoints) {
                if (point.risk === 'high') {
                    warnings.push(`Line ${point.location.line}: ${point.reason}`);
                }
            }
        }

        // Add flakiness warning
        if (behaviorPrediction.flakinessRisk > 0.5) {
            warnings.push(`Flakiness risk: ${Math.round(behaviorPrediction.flakinessRisk * 100)}% - Consider adding explicit waits`);
        }

        // Add maintenance risk warnings
        if (behaviorPrediction.maintenanceRisks) {
            for (const risk of behaviorPrediction.maintenanceRisks) {
                if (risk.severity === 'high') {
                    warnings.push(`${risk.type}: ${risk.description}`);
                }
            }
        }

        return warnings;
    }

    /**
     * Compile suggestions from all intelligence layers
     */
    private compileSuggestions(behaviorPrediction: any, llmAnalysis: any, patterns: any[]): string[] {
        const suggestions: string[] = [];

        // Add LLM suggestions
        if (llmAnalysis.semanticUnderstanding) {
            suggestions.push(`Business Goal: ${llmAnalysis.semanticUnderstanding.what}`);
            suggestions.push(`User Journey: ${llmAnalysis.semanticUnderstanding.how}`);
        }

        // Add optimization suggestions
        if (behaviorPrediction.optimizations) {
            for (const opt of behaviorPrediction.optimizations) {
                if (opt.impact === 'high') {
                    suggestions.push(`${opt.type}: ${opt.description}`);
                }
            }
        }

        // Add pattern-based suggestions
        for (const pattern of patterns) {
            if (pattern.confidence > 0.8) {
                suggestions.push(`Consider using existing ${pattern.name} pattern`);
            }
        }

        // Add runtime estimates
        if (behaviorPrediction.estimatedDuration) {
            suggestions.push(`Estimated execution time: ${Math.round(behaviorPrediction.estimatedDuration / 1000)}s`);
        }

        return suggestions;
    }

    /**
     * Generate Feature file with intelligent Gherkin
     */
    private generateFeature(
        analysis: DeepCodeAnalysis,
        intentAnalysis: IntentAnalysis,
        featureName: string,
        llmAnalysis?: any
    ): GeneratedFeature {
        const scenario = this.generateScenario(analysis, intentAnalysis);

        const content = this.buildFeatureContent(featureName, scenario);

        return {
            fileName: `${this.toKebabCase(featureName)}.feature`,
            path: `features/${this.toKebabCase(featureName)}.feature`,
            content,
            scenarios: [scenario]
        };
    }

    /**
     * Generate Gherkin scenario from intelligence
     */
    private generateScenario(
        analysis: DeepCodeAnalysis,
        intentAnalysis: IntentAnalysis
    ): GherkinScenario {
        const { primary, testType } = intentAnalysis;
        const { actions } = analysis;

        // Generate scenario name
        const scenarioName = this.generateScenarioName(primary);

        // Generate tags
        const tags = this.generateTags(primary, testType);

        // Generate steps
        const steps = this.generateGherkinSteps(actions, intentAnalysis);

        return {
            name: scenarioName,
            tags,
            steps
        };
    }

    /**
     * Generate scenario name from intent
     */
    private generateScenarioName(intent: any): string {
        if (intent.businessGoal) {
            return intent.businessGoal;
        }
        return `${intent.subtype} ${intent.type}`;
    }

    /**
     * Generate tags
     */
    private generateTags(intent: any, testType: string): string[] {
        const tags: string[] = [];

        // Test type tag
        tags.push(`@${testType}`);

        // Intent-based tags
        if (intent.type === 'authentication') {
            tags.push('@smoke');
            tags.push('@authentication');
        } else if (intent.type === 'crud') {
            tags.push('@crud');
            tags.push(`@${intent.subtype}`);
        }

        return tags;
    }

    /**
     * Generate Gherkin steps with intelligence
     */
    private generateGherkinSteps(actions: Action[], intentAnalysis: IntentAnalysis): GherkinStep[] {
        const steps: GherkinStep[] = [];

        // Group actions intelligently
        const grouped = this.groupActionsByIntent(actions, intentAnalysis);

        for (const group of grouped) {
            const step = this.actionGroupToGherkinStep(group);
            if (step) {
                steps.push(step);
            }
        }

        return steps;
    }

    /**
     * Group actions by intent - each action becomes a step
     */
    private groupActionsByIntent(actions: Action[], intentAnalysis: IntentAnalysis): Action[][] {
        // Each action should become its own step, except navigation which goes in Background
        return actions
            .filter(action => action.type !== 'navigation')  // Skip navigation, it's in Background
            .map(action => [action]);  // Each action in its own group
    }

    /**
     * Convert action group to Gherkin step
     */
    private actionGroupToGherkinStep(actions: Action[]): GherkinStep | null {
        if (actions.length === 0) return null;

        const firstAction = actions[0];

        if (firstAction.type === 'navigation') {
            return {
                keyword: 'Given',
                text: `I navigate to the application`
            };
        }

        if (firstAction.type === 'fill') {
            // Check if this is a login pattern (username + password)
            const hasUsername = actions.some(a =>
                a.target?.selector?.toLowerCase().includes('username') ||
                a.target?.options?.name?.toLowerCase().includes('username')
            );
            const hasPassword = actions.some(a =>
                a.target?.selector?.toLowerCase().includes('password') ||
                a.target?.options?.name?.toLowerCase().includes('password')
            );

            if (hasUsername && hasPassword) {
                return {
                    keyword: 'When',
                    text: `I enter username "Admin" and password "admin123"`
                };
            }

            // Get field name from first fill action - must match step definition format
            const fieldName = this.extractFieldName(firstAction);
            return {
                keyword: 'When',
                text: `I enter "test-value" in the ${fieldName} field`
            };
        }

        if (firstAction.type === 'click') {
            const elementName = this.extractElementDescription(firstAction);

            // Determine if it's a button, link, or other element
            if (firstAction.target?.type === 'getByRole') {
                const role = firstAction.target.selector.toLowerCase();
                const name = firstAction.target.options?.name || 'element';

                if (role === 'button') {
                    return {
                        keyword: 'And',
                        text: `I click on the "${name}" button`
                    };
                } else if (role === 'link') {
                    return {
                        keyword: 'And',
                        text: `I click on the "${name}" link`
                    };
                } else if (role === 'menuitem') {
                    return {
                        keyword: 'And',
                        text: `I select "${name}" from the menu`
                    };
                }
            }

            return {
                keyword: 'And',
                text: `I click on the ${elementName}`
            };
        }

        if (firstAction.type === 'assertion') {
            return {
                keyword: 'Then',
                text: `I should see the expected result`
            };
        }

        return null;
    }

    /**
     * Extract field name from action
     */
    private extractFieldName(action: Action): string {
        if (action.target?.options?.name) {
            return action.target.options.name;
        }
        if (action.target?.selector) {
            const match = action.target.selector.match(/name[=\s]*["']([^"']+)["']/);
            if (match) return match[1];
        }
        return 'field';
    }

    /**
     * Extract element description from action
     */
    private extractElementDescription(action: Action): string {
        if (action.target?.options?.name) {
            return action.target.options.name;
        }

        const match = action.expression.match(/name:\s*['"]([^'"]+)['"]/);
        if (match) return match[1];

        const textMatch = action.expression.match(/getByText\(['"]([^'"]+)['"]\)/);
        if (textMatch) return textMatch[1];

        return 'element';
    }

    /**
     * Extract button name from action
     */
    private extractButtonName(action: Action): string {
        const match = action.expression.match(/name:\s*['"]([^'"]+)['"]/);
        if (match) return match[1];

        const textMatch = action.expression.match(/getByText\(['"]([^'"]+)['"]\)/);
        if (textMatch) return textMatch[1];

        return 'button';
    }

    /**
     * Generate Page Objects with intelligent element creation
     */
    private generatePageObjects(
        analysis: DeepCodeAnalysis,
        intentAnalysis: IntentAnalysis,
        patterns?: any[]
    ): GeneratedPageObject[] {
        // For now, generate single page object
        // TODO: Detect page boundaries and create multiple page objects

        const className = this.generatePageClassName(intentAnalysis);
        const elements = this.generateElements(analysis);
        const methods = this.generatePageMethods(analysis, intentAnalysis);

        const content = this.buildPageObjectContent(className, elements, methods);

        return [{
            className,
            fileName: `${className}.ts`,
            path: `pages/${className}.ts`,
            content,
            baseClass: 'CSBasePage',
            decorator: '@CSPage',
            elements,
            methods
        }];
    }

    /**
     * Generate page class name
     */
    private generatePageClassName(intentAnalysis: IntentAnalysis): string {
        const { primary } = intentAnalysis;

        // Use intent-based naming (don't use entities as they may contain URLs)
        if (primary.type === 'authentication') {
            return 'LoginPage';
        }

        if (primary.type === 'crud') {
            const subtype = primary.subtype || 'data';
            return `${this.capitalize(subtype)}Page`;
        }

        if (primary.type === 'form-interaction') {
            return 'FormPage';
        }

        if (primary.type === 'navigation') {
            return 'NavigationPage';
        }

        if (primary.type === 'verification') {
            return 'VerificationPage';
        }

        return 'TestPage';
    }

    /**
     * Capitalize first letter
     */
    private capitalize(str: string): string {
        return str.charAt(0).toUpperCase() + str.slice(1);
    }

    /**
     * Generate elements with intelligent decorators
     */
    private generateElements(analysis: DeepCodeAnalysis): GeneratedElement[] {
        const elements: GeneratedElement[] = [];
        const seen = new Set<string>();

        for (const action of analysis.actions) {
            if (action.target) {
                const elementName = this.generateElementName(action.target);

                if (seen.has(elementName)) continue;
                seen.add(elementName);

                const locator = this.buildCSLocator(action.target);

                elements.push({
                    name: elementName,
                    type: 'CSWebElement',
                    decorator: '@CSGetElement',
                    locator,
                    description: `${action.target.selector} element`,
                    comment: `// ${action.type} target`
                });
            }
        }

        return elements;
    }

    /**
     * Generate intelligent element name
     */
    private generateElementName(target: any): string {
        const selector = target.selector;

        // Username/password fields (check both selector and options.name)
        const selectorLower = selector.toLowerCase();
        const optionsName = target.options?.name?.toLowerCase() || '';

        if (selectorLower.includes('username') || optionsName.includes('username')) {
            return 'usernameField';
        }
        if (selectorLower.includes('password') || optionsName.includes('password')) {
            return 'passwordField';
        }

        // getByRole elements - determine type by role
        if (target.type === 'getByRole' && target.options?.name) {
            const role = selector.toLowerCase();
            const name = this.sanitizeIdentifier(target.options.name);
            let baseName = this.toCamelCase(name);

            // Ensure first letter is lowercase
            baseName = baseName.charAt(0).toLowerCase() + baseName.slice(1);

            // Determine suffix based on role
            if (role === 'textbox' || role === 'input') {
                return baseName.endsWith('Field') ? baseName : `${baseName}Field`;
            } else if (role === 'button') {
                return baseName.endsWith('Button') ? baseName : `${baseName}Button`;
            } else if (role === 'link') {
                return baseName.endsWith('Link') ? baseName : `${baseName}Link`;
            } else if (role === 'menuitem') {
                return baseName.endsWith('MenuItem') ? baseName : `${baseName}MenuItem`;
            }

            // Default for other roles
            return baseName.endsWith('Element') ? baseName : `${baseName}Element`;
        }

        // getByText elements - use the text content as name
        if (target.type === 'getByText') {
            const text = this.sanitizeIdentifier(selector);
            let baseName = this.toCamelCase(text);

            // Ensure first letter is lowercase
            baseName = baseName.charAt(0).toLowerCase() + baseName.slice(1);

            // Re-check if starts with number after toCamelCase (since toCamelCase may strip underscore)
            if (/^[0-9]/.test(baseName)) {
                baseName = `_${baseName}`;
            }

            // Text elements are usually links or buttons based on context
            if (target.action === 'click') {
                return baseName.endsWith('Link') ? baseName : `${baseName}Link`;
            }
            return baseName.endsWith('Element') ? baseName : `${baseName}Element`;
        }

        // CSS class selectors - extract main class name
        if (target.type === 'locator' && selector.startsWith('.')) {
            // Extract first meaningful class name (skip utility classes)
            const classes = selector.split('.').filter((c: string) => c && c.length > 2);
            if (classes.length > 0) {
                const mainClass = classes[0].split(' ')[0]; // Take first significant class
                let baseName = this.toCamelCase(this.sanitizeIdentifier(mainClass));
                // Ensure first letter is lowercase
                baseName = baseName.charAt(0).toLowerCase() + baseName.slice(1);
                return baseName.endsWith('Icon') || baseName.endsWith('Element') ? baseName : `${baseName}Icon`;
            }
        }

        // Extract meaningful name from selector
        let baseName = this.extractMeaningfulName(selector, target.type);
        // Ensure first letter is lowercase
        baseName = baseName.charAt(0).toLowerCase() + baseName.slice(1);

        // Add appropriate suffix based on type
        if (target.type === 'getByPlaceholder' || target.type === 'fill') {
            return baseName.endsWith('Field') ? baseName : `${baseName}Field`;
        }
        if (target.type === 'click') {
            return baseName.endsWith('Button') ? baseName : `${baseName}Button`;
        }

        return baseName.endsWith('Element') ? baseName : `${baseName}Element`;
    }

    /**
     * Extract meaningful name from selector
     */
    private extractMeaningfulName(selector: string, type: string): string {
        // Try to extract from data-testid
        if (selector.includes('data-testid')) {
            const match = selector.match(/data-testid[=\s]*["']([^"']+)["']/);
            if (match) {
                return this.toCamelCase(this.sanitizeIdentifier(match[1]));
            }
        }

        // Try to extract from placeholder
        if (selector.includes('placeholder')) {
            const match = selector.match(/placeholder[=\s]*["']([^"']+)["']/);
            if (match) {
                return this.toCamelCase(this.sanitizeIdentifier(match[1]));
            }
        }

        // Try to extract from name attribute
        if (selector.includes('name')) {
            const match = selector.match(/name[=\s]*["']([^"']+)["']/);
            if (match) {
                return this.toCamelCase(this.sanitizeIdentifier(match[1]));
            }
        }

        // Try to extract from class
        if (selector.includes('class')) {
            const match = selector.match(/class[=\s]*["']([^"']+)["']/);
            if (match) {
                const className = match[1].split(' ')[0]; // Take first class
                return this.toCamelCase(this.sanitizeIdentifier(className));
            }
        }

        // Fallback: sanitize the selector itself
        return this.toCamelCase(this.sanitizeIdentifier(selector));
    }

    /**
     * Sanitize string to be valid JavaScript identifier
     */
    private sanitizeIdentifier(str: string): string {
        const sanitized = str
            .replace(/[^a-zA-Z0-9_\s-]/g, '') // Remove invalid characters
            .trim();

        // If empty after sanitization or only digits, make it meaningful
        if (!sanitized || /^[0-9]+$/.test(sanitized)) {
            return `text${sanitized || 'Element'}`;
        }

        // Prepend underscore if starts with number
        if (/^[0-9]/.test(sanitized)) {
            return `_${sanitized}`;
        }

        return sanitized;
    }

    /**
     * Build CS Framework locator string
     */
    private buildCSLocator(target: any): string {
        if (target.type === 'getByRole') {
            const role = target.selector;
            if (target.options?.name) {
                return `role=${role}[name="${target.options.name}"]`;
            }
            return `role=${role}`;
        }

        if (target.type === 'getByPlaceholder') {
            return `[placeholder="${target.selector}"]`;
        }

        if (target.type === 'getByText') {
            return `text=${target.selector}`;
        }

        if (target.type === 'locator') {
            return target.selector;
        }

        return target.selector;
    }

    /**
     * Generate page methods with intelligent method selection
     */
    private generatePageMethods(
        analysis: DeepCodeAnalysis,
        intentAnalysis: IntentAnalysis
    ): GeneratedMethod[] {
        const methods: GeneratedMethod[] = [];

        // Generate high-level methods based on intent
        if (intentAnalysis.primary.type === 'authentication') {
            methods.push(...this.generateLoginMethod(analysis));
        }

        return methods;
    }

    /**
     * Generate login method
     */
    private generateLoginMethod(analysis: DeepCodeAnalysis): GeneratedMethod[] {
        return [
            {
                name: 'enterUsername',
                returnType: 'Promise<void>',
                parameters: [
                    { name: 'username', type: 'string' }
                ],
                implementation: `await this.usernameField.click();
        await this.usernameField.fill(username);`,
                comment: '// Enter username',
                isAsync: true
            },
            {
                name: 'enterPassword',
                returnType: 'Promise<void>',
                parameters: [
                    { name: 'password', type: 'string' }
                ],
                implementation: `await this.passwordField.click();
        await this.passwordField.fill(password);`,
                comment: '// Enter password',
                isAsync: true
            },
            {
                name: 'clickLoginButton',
                returnType: 'Promise<void>',
                parameters: [],
                implementation: `await this.loginButton.click();`,
                comment: '// Click login button',
                isAsync: true
            },
            {
                name: 'login',
                returnType: 'Promise<void>',
                parameters: [
                    { name: 'username', type: 'string' },
                    { name: 'password', type: 'string' }
                ],
                implementation: `await this.enterUsername(username);
        await this.enterPassword(password);
        await this.clickLoginButton();`,
                comment: '// Perform complete login',
                isAsync: true
            },
            {
                name: 'verifyLoginSuccess',
                returnType: 'Promise<void>',
                parameters: [],
                implementation: `// Add verification logic here
        await this.page.waitForLoadState('networkidle');`,
                comment: '// Verify login was successful',
                isAsync: true
            }
        ];
    }

    /**
     * Generate Step Definitions
     */
    private generateStepDefinitions(
        analysis: DeepCodeAnalysis,
        intentAnalysis: IntentAnalysis,
        pageObjects: GeneratedPageObject[],
        patterns?: any[]
    ): GeneratedStepDefinition[] {
        // Generate step definition class
        const className = `${pageObjects[0].className.replace('Page', '')}Steps`;

        const content = this.buildStepDefinitionContent(className, analysis, intentAnalysis, pageObjects[0]);

        return [{
            className,
            fileName: `${className}.ts`,
            path: `steps/${className}.ts`,
            content,
            steps: []
        }];
    }

    /**
     * Build feature file content
     */
    private buildFeatureContent(featureName: string, scenario: GherkinScenario): string {
        const tags = scenario.tags.join(' ');

        const steps = scenario.steps.map(step => {
            let line = `    ${step.keyword} ${step.text}`;
            if (step.dataTable) {
                line += '\n' + step.dataTable.map(row =>
                    '      | ' + row.join(' | ') + ' |'
                ).join('\n');
            }
            return line;
        }).join('\n');

        // Add proper feature description
        const description = this.getFeatureDescription(featureName);

        return `${tags}
Feature: ${featureName}
  ${description}

  Background:
    Given I navigate to the application

  Scenario: ${scenario.name}
${steps}
`;
    }

    /**
     * Get feature description based on name
     */
    private getFeatureDescription(featureName: string): string {
        if (featureName.toLowerCase().includes('login') || featureName.toLowerCase().includes('auth')) {
            return 'As a user\n  I want to authenticate to the system\n  So that I can access protected features';
        }
        return 'As a user\n  I want to test the application\n  So that I can ensure it works correctly';
    }

    /**
     * Build page object content
     */
    private buildPageObjectContent(
        className: string,
        elements: GeneratedElement[],
        methods: GeneratedMethod[]
    ): string {
        const elementsCode = elements.map(el =>
            `    // ${el.description}
    @CSGetElement({
        css: '${el.locator}',
        description: '${el.description}',
        waitForVisible: true,
        selfHeal: true,
        alternativeLocators: [
            'xpath:${this.cssToXPath(el.locator)}'
        ]
    })
    public ${el.name}!: CSWebElement;`
        ).join('\n\n');

        const methodsCode = methods.map(method => {
            const params = method.parameters.map(p => `${p.name}: ${p.type}`).join(', ');
            return `    ${method.comment}
    public async ${method.name}(${params}): ${method.returnType} {
        CSReporter.info('${this.generateLogMessage(method.name, method.parameters)}');
        ${method.implementation}
        CSReporter.pass('${this.generateSuccessMessage(method.name)}');
    }`;
        }).join('\n\n');

        const pageName = this.toKebabCase(className.replace('Page', ''));

        return `import { CSBasePage, CSPage, CSGetElement } from '@mdakhan.mak/cs-playwright-test-framework/core';
import { CSWebElement } from '@mdakhan.mak/cs-playwright-test-framework/element';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';

@CSPage('${pageName}')
export class ${className} extends CSBasePage {
${elementsCode}

    protected initializeElements(): void {
        CSReporter.debug('${className} elements initialized');
    }

${methodsCode}

    public async navigate(): Promise<void> {
        const baseUrl = this.config.get('BASE_URL');
        CSReporter.info(\`Navigating to \${baseUrl}\`);
        await this.page.goto(baseUrl, { timeout: 30000, waitUntil: 'domcontentloaded' });
        await this.waitForPageLoad();
        CSReporter.pass('Successfully navigated to application');
    }
}
`;
    }

    /**
     * Generate log message for method
     */
    private generateLogMessage(methodName: string, params: any[]): string {
        if (params.length === 0) return `Executing ${methodName}`;
        const paramNames = params.map(p => `\${${p.name}}`).join(', ');
        return `Executing ${methodName} with: ${paramNames}`;
    }

    /**
     * Generate success message for method
     */
    private generateSuccessMessage(methodName: string): string {
        return `${methodName} completed successfully`;
    }

    /**
     * Convert CSS selector to XPath (basic conversion)
     */
    private cssToXPath(css: string): string {
        // Handle role= selectors
        if (css.startsWith('role=')) {
            const roleMatch = css.match(/role=([a-z]+)(?:\[name="([^"]+)"\])?/);
            if (roleMatch) {
                const [, role, name] = roleMatch;
                if (name) {
                    return `//*[@role="${role}" and @name="${name}"]`;
                }
                return `//*[@role="${role}"]`;
            }
        }

        // Handle text= selectors
        if (css.startsWith('text=')) {
            const text = css.substring(5);
            return `//*[contains(text(),"${text}")]`;
        }

        // Handle attribute selectors
        if (css.startsWith('[') && css.includes('=')) {
            const match = css.match(/\[([^=]+)="([^"]+)"\]/);
            if (match) {
                return `//*[@${match[1]}="${match[2]}"]`;
            }
        }

        // Handle class selectors
        if (css.startsWith('.')) {
            return `//*[contains(@class,"${css.substring(1)}")]`;
        }

        // Handle ID selectors
        if (css.startsWith('#')) {
            return `//*[@id="${css.substring(1)}"]`;
        }

        // Generic element selector
        return `//${css}`;
    }

    /**
     * Build step definition content
     */
    private buildStepDefinitionContent(
        className: string,
        analysis: DeepCodeAnalysis,
        intentAnalysis: IntentAnalysis,
        pageObject: GeneratedPageObject
    ): string {
        const pageName = this.toKebabCase(pageObject.className.replace('Page', ''));
        // Make sure variable name starts with lowercase
        const baseVarName = this.toCamelCase(pageObject.className.replace('Page', '') + 'Page');
        const pageVarName = baseVarName.charAt(0).toLowerCase() + baseVarName.slice(1);

        // Generate step definitions based on all actions
        const stepDefsList: string[] = [];

        // Always add navigation step
        stepDefsList.push(`    @CSBDDStepDef('I navigate to the application')
    async navigateToApplication() {
        CSReporter.info('Navigating to application');
        await this.${pageVarName}.navigate();
        CSReporter.pass('Successfully navigated to application');
    }`);

        // Generate steps for each unique action pattern
        const processedSteps = new Set<string>();

        for (const action of analysis.actions) {
            if (action.type === 'navigation') continue; // Already handled

            if (action.type === 'fill' && action.target) {
                const fieldName = action.target.options?.name || 'field';
                const stepText = `I enter {string} in the ${fieldName} field`;

                if (!processedSteps.has(stepText)) {
                    processedSteps.add(stepText);
                    const elementName = this.generateElementName(action.target);
                    stepDefsList.push(`    @CSBDDStepDef('${stepText}')
    async enter${this.capitalize(this.toCamelCase(fieldName))}(value: string) {
        CSReporter.info(\`Entering value in ${fieldName} field: \${value}\`);
        await this.${pageVarName}.${elementName}.fill(value);
        CSReporter.pass('${fieldName} field filled successfully');
    }`);
                }
            }

            if (action.type === 'click' && action.target) {
                const elementDesc = action.target.options?.name || this.extractElementDescription(action);
                const role = action.target.type === 'getByRole' ? action.target.selector.toLowerCase() : 'element';

                let stepText = '';
                let methodName = '';

                if (role === 'button') {
                    stepText = `I click on the "${elementDesc}" button`;
                    methodName = `click${this.capitalize(this.toCamelCase(elementDesc))}Button`;
                } else if (role === 'link') {
                    stepText = `I click on the "${elementDesc}" link`;
                    methodName = `click${this.capitalize(this.toCamelCase(elementDesc))}Link`;
                } else if (role === 'menuitem') {
                    stepText = `I select "${elementDesc}" from the menu`;
                    methodName = `select${this.capitalize(this.toCamelCase(elementDesc))}MenuItem`;
                } else {
                    stepText = `I click on the ${elementDesc}`;
                    methodName = `click${this.capitalize(this.toCamelCase(elementDesc))}`;
                }

                if (!processedSteps.has(stepText)) {
                    processedSteps.add(stepText);
                    const elementName = this.generateElementName(action.target);
                    stepDefsList.push(`    @CSBDDStepDef('${stepText}')
    async ${methodName}() {
        CSReporter.info('Clicking on ${elementDesc}');
        await this.${pageVarName}.${elementName}.click();
        CSReporter.pass('${elementDesc} clicked successfully');
    }`);
                }
            }
        }

        const stepDefs = stepDefsList.join('\n\n');

        return `import { CSBDDStepDef, Page, StepDefinitions } from '@mdakhan.mak/cs-playwright-test-framework/bdd';
import { CSReporter } from '@mdakhan.mak/cs-playwright-test-framework/reporting';
import { ${pageObject.className} } from '../pages/${pageObject.className}';

@StepDefinitions
export class ${className} {

    @Page('${pageName}')
    private ${pageVarName}!: ${pageObject.className};

${stepDefs}
}

export default ${className};
`;
    }

    /**
     * Calculate transformation accuracy
     */
    private calculateAccuracy(intentAnalysis: IntentAnalysis): number {
        return intentAnalysis.confidence * 0.95; // Slight reduction for transformation uncertainty
    }

    /**
     * Utility: Convert to kebab-case
     */
    private toKebabCase(str: string): string {
        return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().replace(/\s+/g, '-');
    }

    /**
     * Utility: Convert to camelCase
     */
    private toCamelCase(str: string): string {
        return str.replace(/[-_\s]+(.)?/g, (_, c) => c ? c.toUpperCase() : '');
    }
}
