/**
 * DIRECT CODE GENERATOR
 *
 * Intelligent conversion of Playwright actions to CS Framework code.
 * Uses intelligence utilities for:
 * - Noise removal and deduplication
 * - Proper naming conventions
 * - Page boundary detection
 * - Multi-locator generation for self-healing
 * - Auto-assertion suggestions
 * - Code quality analysis
 */

import { Action, GeneratedCSCode } from '../types';
import { CSReporter } from '../../reporter/CSReporter';
import {
    ActionFilter,
    NamingEngine,
    FlowDetector,
    LocatorGenerator,
    TestDataExtractor,
    AssertionSuggester,
    CodeQualityAnalyzer,
    type FilteredActions,
    type PageBoundary,
    type ElementNaming,
    type MethodNaming,
    type GeneratedLocators,
    type VerificationPoint,
    type QualityReport
} from '../intelligence';

interface Element {
    name: string;
    selector: string;
    selectorType: string;
    description: string;
    alternativeLocators: string[];
    stabilityScore: number;
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
    private globalStepRegistry: Set<string> = new Set(); // Track step patterns globally to avoid duplicates

    /**
     * Generate CS Framework code from actions using intelligence utilities
     */
    public generate(actions: Action[]): GeneratedCSCode {
        CSReporter.info('🔨 Intelligent Code Generation');
        CSReporter.info(`   Processing ${actions.length} raw actions...`);

        // Reset state
        this.elementCounter = 0;
        this.pages.clear();
        this.elementRegistry.clear();
        this.methodRegistry.clear();
        this.elementNameRegistry.clear();
        this.globalStepRegistry.clear();

        // STEP 1: Filter actions - remove noise, duplicates, merge actions
        const filteredResult: FilteredActions = ActionFilter.filter(actions);
        const filteredActions = filteredResult.actions;

        CSReporter.info(`   Filtered to ${filteredActions.length} meaningful actions`);
        CSReporter.info(`   Removed ${filteredResult.stats.noiseRemoved} noise actions`);
        CSReporter.info(`   Merged ${filteredResult.stats.merged} actions`);
        CSReporter.info(`   Deduplicated ${filteredResult.stats.duplicatesRemoved} actions`);

        // STEP 2: Detect page boundaries for proper page splitting
        const pageBoundaries: PageBoundary[] = FlowDetector.detectPageBoundaries(filteredActions);
        CSReporter.info(`   Detected ${pageBoundaries.length} pages`);

        // STEP 3: Detect flows for proper Gherkin keywords (Given/When/Then)
        const detectedFlows = FlowDetector.detectFlows(filteredActions);
        CSReporter.info(`   Detected ${detectedFlows.length} flows`);

        // STEP 4: Extract test data for parameterization
        const testData = TestDataExtractor.extract(filteredActions);
        CSReporter.info(`   Extracted ${Object.keys(testData.data).length} test data values`);
        if (testData.sensitiveFields.length > 0) {
            CSReporter.warn(`   Found ${testData.sensitiveFields.length} sensitive fields (masked)`);
        }

        // STEP 5: Suggest assertions for verification points
        const verificationPoints: VerificationPoint[] = AssertionSuggester.suggestAssertions(filteredActions);
        CSReporter.info(`   Suggested ${verificationPoints.length} verification points`);

        // STEP 6: Process each action with page context
        const gherkinSteps: string[] = [];
        let currentPageIndex = 0;
        let currentPage = pageBoundaries.length > 0 ? pageBoundaries[0].pageName : 'Main';

        for (let i = 0; i < filteredActions.length; i++) {
            const action = filteredActions[i];

            // Check if we crossed a page boundary
            if (currentPageIndex < pageBoundaries.length - 1) {
                const nextBoundary = pageBoundaries[currentPageIndex + 1];
                if (i >= nextBoundary.startIndex) {
                    currentPageIndex++;
                    currentPage = nextBoundary.pageName;
                    CSReporter.debug(`   Switched to page: ${currentPage}`);
                }
            }

            // Convert action to page element + method + Gherkin
            const result = this.convertAction(action, currentPage, i, detectedFlows);
            if (result) {
                gherkinSteps.push(result.gherkinStep);
            }

            // Check if there's a verification point after this action
            const verificationPoint = verificationPoints.find(vp => vp.afterActionIndex === i);
            if (verificationPoint && verificationPoint.suggestions.length > 0) {
                // Add the highest confidence assertion
                const topAssertion = verificationPoint.suggestions[0];
                if (topAssertion.confidence >= 0.7) {
                    gherkinSteps.push(topAssertion.gherkinStep);
                }
            }
        }

        // Build the output
        const output = this.buildOutput(gherkinSteps, testData);

        // STEP 7: Analyze code quality
        const qualityReport: QualityReport = CodeQualityAnalyzer.analyze(output, filteredActions);
        CSReporter.info(`   Code Quality Score: ${qualityReport.overallScore.toFixed(1)}/100`);

        if (qualityReport.issues.length > 0) {
            CSReporter.warn(`   Found ${qualityReport.issues.length} quality issues`);
            for (const issue of qualityReport.issues.slice(0, 3)) {
                CSReporter.debug(`   - ${issue.message}`);
            }
        }

        return output;
    }

    /**
     * Convert a single action to element + method + Gherkin using intelligence utilities
     */
    private convertAction(
        action: Action,
        pageName: string,
        index: number,
        detectedFlows: ReturnType<typeof FlowDetector.detectFlows> = []
    ): { gherkinStep: string } | null {
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

        // Determine Gherkin keyword based on flow detection
        const gherkinKeyword = this.determineGherkinKeyword(action, index, detectedFlows);

        // Extract element info (but skip for navigation actions)
        let elementName = '';
        if (action.type !== 'navigation') {
            // Use NamingEngine for proper naming
            const elementNaming: ElementNaming = NamingEngine.generateElementNaming(action, pageName);
            const baseElementName = elementNaming.propertyName;

            // Use LocatorGenerator for multi-locator with stability scoring
            const locators: GeneratedLocators = LocatorGenerator.generate(action);
            const selector = locators.primary.value;
            const selectorType = locators.primary.type;
            const elementKey = `${baseElementName}:${selector}`; // Unique key for deduplication

            // Only create element if it doesn't exist and selector is not empty (deduplication)
            if (!pageElementRegistry.has(elementKey) && selector) {
                // Ensure element name is unique (deduplicate property names)
                let uniqueElementName = NamingEngine.sanitizeIdentifier(baseElementName);
                uniqueElementName = NamingEngine.makeUnique(uniqueElementName, pageElementNameRegistry);
                pageElementNameRegistry.add(uniqueElementName);
                elementName = uniqueElementName;

                // Format locators for @CSGetElement decorator
                const formattedLocators = LocatorGenerator.formatForDecorator(locators);

                const element: Element = {
                    name: elementName,
                    selector: formattedLocators.primary.value,
                    selectorType: formattedLocators.primary.type,
                    description: elementNaming.description,
                    alternativeLocators: formattedLocators.alternatives,
                    stabilityScore: locators.stabilityScore
                };
                page.elements.push(element);
                pageElementRegistry.add(elementKey);
            } else {
                // Element already exists, use the existing name
                const existingElement = page.elements.find(e =>
                    e.selector === selector
                );
                elementName = existingElement?.name || NamingEngine.sanitizeIdentifier(baseElementName);
            }
        }

        // Create method based on action type using NamingEngine
        let methodName: string;
        let gherkinStep: string;
        let params: Array<{ name: string; type: string }> = [];
        let pressKey: string | undefined;

        // Use NamingEngine for method naming
        const elementNaming: ElementNaming = action.type !== 'navigation'
            ? NamingEngine.generateElementNaming(action, pageName)
            : { propertyName: '', description: '', methodPrefix: '', parameterName: '' };
        const methodNaming: MethodNaming = NamingEngine.generateMethodNaming(action, elementNaming);

        switch (action.type) {
            case 'navigation':
                const url = action.args[0] as string;
                const pageFromUrl = this.extractPageNameFromUrl(url);
                methodName = `navigateTo${NamingEngine.toPascalCase([pageFromUrl])}Page`;
                gherkinStep = `${gherkinKeyword} I navigate to the ${pageFromUrl.toLowerCase()} page`;
                params = [{ name: 'url', type: 'string' }];
                break;

            case 'fill':
                methodName = methodNaming.methodName;
                const fillValue = action.args[0] as string;
                const fieldDescription = elementNaming.description;
                gherkinStep = `${gherkinKeyword} I enter "${fillValue}" in the ${fieldDescription}`;
                params = [{ name: elementNaming.parameterName || 'value', type: 'string' }];
                break;

            case 'click':
                methodName = methodNaming.methodName;
                gherkinStep = `${gherkinKeyword} I click the ${elementNaming.description}`;
                break;

            case 'assertion':
                const assertTarget = this.extractAssertionTarget(action);
                const assertType = this.extractAssertionType(action);

                // Handle toContainText specially - it needs element name and text parameters
                if (action.method.includes('toContainText')) {
                    const textToCheck = action.args && action.args.length > 0 ? action.args[0] as string : '';
                    // Create descriptive method and step that includes both element and text
                    const elementDesc = assertTarget || 'element';
                    methodName = `verify${NamingEngine.toPascalCase(elementDesc.split(' '))}ContainsText`;
                    // Use parameterized step: I verify "<element>" contains text "<text>"
                    gherkinStep = `Then I verify "${elementDesc}" contains text "${textToCheck}"`;
                    params = [{ name: 'expectedText', type: 'string' }];
                } else {
                    methodName = `verify${NamingEngine.toPascalCase(assertTarget.split(' '))}${NamingEngine.toPascalCase([assertType])}`;
                    gherkinStep = `Then I should see ${assertTarget} is ${assertType}`;
                }
                break;

            default:
                // Handle press() action specially
                if (action.method === 'press' && action.args && action.args.length > 0) {
                    pressKey = action.args[0] as string;
                    const pressFieldDesc = elementNaming.description;
                    methodName = `press${NamingEngine.toPascalCase([pressKey])}On${NamingEngine.toPascalCase(pressFieldDesc.split(' '))}`;
                    gherkinStep = `${gherkinKeyword} I press ${pressKey} on the ${pressFieldDesc}`;
                } else {
                    methodName = methodNaming.methodName;
                    gherkinStep = `${gherkinKeyword} I ${action.method}`;
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
     * Determine Gherkin keyword based on action context and flow detection
     */
    private determineGherkinKeyword(
        action: Action,
        index: number,
        detectedFlows: ReturnType<typeof FlowDetector.detectFlows>
    ): 'Given' | 'When' | 'Then' {
        // Navigation is typically a precondition (Given)
        if (action.type === 'navigation' && index === 0) {
            return 'Given';
        }

        // Assertions are outcomes (Then)
        if (action.type === 'assertion') {
            return 'Then';
        }

        // Check if action is part of a detected flow
        for (const flow of detectedFlows) {
            if (index >= flow.startIndex && index <= flow.endIndex) {
                // First action in a flow is often setup (Given)
                if (index === flow.startIndex && flow.type === 'login') {
                    return 'Given';
                }
                // Last action in certain flows may be verification
                if (index === flow.endIndex && ['form-submit', 'search'].includes(flow.type)) {
                    return 'Then';
                }
            }
        }

        // Default to When for actions
        return 'When';
    }

    /**
     * Extract page name from URL
     */
    private extractPageNameFromUrl(url: string): string {
        try {
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split('/').filter(p => p);

            // Check for common page indicators
            for (const part of pathParts) {
                const lower = part.toLowerCase();
                if (lower.includes('login')) return 'Login';
                if (lower.includes('admin')) return 'Admin';
                if (lower.includes('dashboard')) return 'Dashboard';
                if (lower.includes('pim')) return 'PIM';
                if (lower.includes('leave')) return 'Leave';
                if (lower.includes('time')) return 'Time';
                if (lower.includes('recruitment')) return 'Recruitment';
                if (lower.includes('profile')) return 'Profile';
                if (lower.includes('settings')) return 'Settings';
                if (lower.includes('home')) return 'Home';
            }

            // Use the first meaningful path segment
            if (pathParts.length > 0) {
                return NamingEngine.toPascalCase(pathParts[0].split(/[-_]/));
            }

            // Fallback to hostname-based naming
            const hostParts = urlObj.hostname.split('.');
            if (hostParts.length > 1) {
                return NamingEngine.toPascalCase([hostParts[0]]);
            }
        } catch {
            // If URL parsing fails, fall back to simple matching
            if (url.includes('login')) return 'Login';
            if (url.includes('admin')) return 'Admin';
            if (url.includes('dashboard')) return 'Dashboard';
        }

        return 'Main';
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
     * Build final output with test data
     */
    private buildOutput(
        gherkinSteps: string[],
        testData?: ReturnType<typeof TestDataExtractor.extract>
    ): GeneratedCSCode {
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

        // Build single feature file with data-driven Scenario Outline
        const feature = {
            fileName: 'test-scenario.feature',
            path: 'codegen/test/features/test-scenario.feature',
            content: this.buildFeatureContent(gherkinSteps, testData),
            scenarios: [{
                name: 'Execute recorded test flow',
                tags: ['@smoke', '@regression', '@codegen', '@fullFlow'],
                steps: gherkinSteps.map(step => ({
                    keyword: (step.startsWith('Given') ? 'Given' : step.startsWith('Then') ? 'Then' : 'When') as 'Given' | 'When' | 'Then',
                    text: step.replace(/^(Given|When|Then)\s+/, '')
                }))
            }]
        };

        // Build components including test data file
        const components: any[] = [];
        if (testData && Object.keys(testData.data).length > 0) {
            components.push({
                type: 'testData',
                fileName: 'test-data.json',
                content: testData.dataFile
            });

            // Add environment variables file if any
            if (testData.environmentVariables.length > 0) {
                const envContent = testData.environmentVariables
                    .map(env => `${env.name}=${env.value} # ${env.description}`)
                    .join('\n');
                components.push({
                    type: 'environment',
                    fileName: '.env.example',
                    content: envContent
                });
            }
        }

        return {
            feature,
            features: [feature],
            pageObjects,
            stepDefinitions,
            components,
            metadata: {
                timestamp: Date.now(),
                version: '2.0.0',
                generatedBy: 'DirectCodeGenerator with Intelligence',
                intelligence: {
                    patterns: this.pages.size,
                    pages: this.pages.size,
                    steps: stepDefinitions.reduce((sum, s) => sum + (s.content.match(/@CSBDDStepDef/g) || []).length, 0),
                    features: 1,
                    testDataFields: testData ? Object.keys(testData.data).length : 0,
                    sensitiveFields: testData ? testData.sensitiveFields.length : 0
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
        content += ` * Generated by CS Playwright Test Framework with Intelligence\n`;
        content += ` */\n`;
        content += `@CSPage('${NamingEngine.toKebabCase(page.name)}')\n`;
        content += `export class ${page.name}Page extends CSBasePage {\n\n`;

        // Add section header for elements
        content += `    // ===================================================================\n`;
        content += `    // PAGE ELEMENTS\n`;
        content += `    // ===================================================================\n\n`;

        // Add elements with proper decorators and alternative locators from LocatorGenerator
        for (const element of page.elements) {
            // Use pre-generated locator info from LocatorGenerator
            const locatorType = element.selectorType === 'xpath' || element.selector.startsWith('/') ? 'xpath' : 'css';
            const alternativeLocators = element.alternativeLocators || [];

            content += `    @CSGetElement({\n`;
            content += `        ${locatorType}: '${this.escapeString(element.selector)}',\n`;
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
                // Navigation uses framework's navigate() method (NOT direct Playwright page.goto)
                const urlParam = method.params.length > 0 ? method.params[0].name : "''";
                content += `        await this.navigate(${urlParam});\n`;
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
     * Escape string for use in regular expression
     */
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
        const pageIdentifier = NamingEngine.toKebabCase(page.name);
        const pagePropertyName = NamingEngine.toCamelCase(page.name.split(/(?=[A-Z])/)) + 'Page';

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
        content += ` * Generated by CS Playwright Test Framework with Intelligence\n`;
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

        // Add step methods with REUSABLE Cucumber expressions to avoid duplicates
        for (const method of page.methods) {
            const gherkinText = method.gherkinStep.replace(/^(Given|When|Then)\s+/, '');

            // Create REUSABLE Cucumber expression pattern
            // Replace specific values with {string} placeholders for reusability
            let cucumberPattern = this.createReusableStepPattern(gherkinText, method);

            // Check if this pattern already exists globally
            if (this.globalStepRegistry.has(cucumberPattern)) {
                // Pattern already exists in another step file - skip to avoid duplicate
                CSReporter.debug(`   Skipping duplicate step pattern: ${cucumberPattern}`);
                continue;
            }

            // Register the pattern globally
            this.globalStepRegistry.add(cucumberPattern);

            // Generate step method name that's unique (avoid collision with page method)
            const stepMethodName = `step${this.toPascalCase(method.name)}`;

            // Determine parameters based on pattern (for step definition signature)
            const patternParams = this.extractPatternParameters(cucumberPattern, method);
            const stepParams = patternParams.map(p => `${p.name}: ${p.type}`).join(', ');

            // Map step parameters to page method parameters
            // The page method has its own params (method.params), we need to call it with matching values
            const pageMethodArgs = this.mapStepParamsToPageMethod(patternParams, method);

            content += `    /**\n`;
            content += `     * Step: ${gherkinText}\n`;
            content += `     */\n`;
            content += `    @CSBDDStepDef('${this.escapeString(cucumberPattern)}')\n`;
            content += `    async ${stepMethodName}(${stepParams}): Promise<void> {\n`;
            content += `        CSReporter.info('Executing step: ${this.escapeString(gherkinText)}');\n\n`;

            // Call page object method (NOT recursive step call!)
            content += `        // Call page object method to perform the action\n`;
            content += `        await this.${pagePropertyName}.${method.name}(${pageMethodArgs});\n\n`;

            content += `        CSReporter.pass('Step completed: ${this.escapeString(gherkinText)}');\n`;
            content += `    }\n\n`;
        }

        content += `}\n\n`;
        content += `export default ${page.name}Steps;\n`;
        return content;
    }

    /**
     * Create reusable step pattern by replacing specific values with {string} placeholders
     * This prevents duplicate step patterns across files
     */
    private createReusableStepPattern(gherkinText: string, method: PageMethod): string {
        let pattern = gherkinText;

        // Replace quoted strings with {string} placeholder
        pattern = pattern.replace(/"([^"]+)"/g, '{string}');

        // Parameterize fill/enter steps - field name should also be parameterized
        // e.g., "I enter {string} in the Username field" -> "I enter {string} in the {string}"
        if (pattern.includes('I enter') && pattern.includes('in the')) {
            // Replace "in the XYZ field" or "in the XYZ" with "in the {string}"
            pattern = pattern.replace(/in the ([A-Za-z][\w\s]*?)( field)?$/, 'in the {string}');
        }

        // Make element-specific steps reusable by parameterizing the element name
        // e.g., "I should see Dashboard is visible" -> "I should see {string} is visible"
        if (pattern.includes('I should see') && pattern.includes('is visible')) {
            pattern = pattern.replace(/I should see ([A-Za-z][\w\s]*?) is visible/, 'I should see {string} is visible');
        }

        // Parameterize click steps for specific elements
        // e.g., "I click the Admin link" -> "I click the {string} link"
        if (pattern.includes('I click the') && !pattern.includes('{string}')) {
            pattern = pattern.replace(/I click the ([A-Za-z][\w\s]*?) (link|button|element|checkbox|row)/, 'I click the {string} $2');
        }

        // Parameterize navigation steps
        if (pattern.includes('I navigate to the') && pattern.includes('page')) {
            pattern = pattern.replace(/I navigate to the (\w+) page/, 'I navigate to the {string} page');
        }

        // Fix toContainText - make it a proper parameterized pattern
        if (pattern === 'I toContainText' || pattern.includes('toContainText')) {
            pattern = 'I verify {string} contains text {string}';
        }

        // Parameterize press key steps
        if (pattern.includes('I press') && pattern.includes('on the')) {
            pattern = pattern.replace(/I press (\w+) on the (.+)/, 'I press {string} on the {string}');
        }

        return pattern;
    }

    /**
     * Extract parameters from a step pattern for method signature
     */
    private extractPatternParameters(pattern: string, method: PageMethod): Array<{ name: string; type: string }> {
        const params: Array<{ name: string; type: string }> = [];
        const stringCount = (pattern.match(/\{string\}/g) || []).length;

        // Generate parameter names based on context
        if (stringCount === 0) {
            return method.params;
        }

        // Create meaningful parameter names based on pattern context
        if (pattern.includes('I should see') && pattern.includes('is visible')) {
            params.push({ name: 'elementName', type: 'string' });
        } else if (pattern.includes('I click the') && pattern.includes('{string}')) {
            params.push({ name: 'elementName', type: 'string' });
        } else if (pattern.includes('I navigate to')) {
            params.push({ name: 'pageName', type: 'string' });
        } else if (pattern.includes('I enter') && pattern.includes('in the')) {
            params.push({ name: 'value', type: 'string' });
            if (stringCount > 1) {
                params.push({ name: 'fieldName', type: 'string' });
            }
        } else if (pattern.includes('I verify') && pattern.includes('contains text')) {
            params.push({ name: 'elementName', type: 'string' });
            params.push({ name: 'expectedText', type: 'string' });
        } else if (pattern.includes('I press')) {
            params.push({ name: 'key', type: 'string' });
            if (stringCount > 1) {
                params.push({ name: 'fieldName', type: 'string' });
            }
        } else {
            // Default: use generic param names
            for (let i = 0; i < stringCount; i++) {
                params.push({ name: `param${i + 1}`, type: 'string' });
            }
        }

        return params;
    }

    /**
     * Map step parameters to page method parameters
     * The step may have more parameters (like elementName for reusability) than the page method needs
     */
    private mapStepParamsToPageMethod(
        stepParams: Array<{ name: string; type: string }>,
        method: PageMethod
    ): string {
        // If page method has no parameters, don't pass anything
        if (method.params.length === 0) {
            return '';
        }

        // Map each page method parameter to the corresponding step parameter
        const args: string[] = [];
        for (const methodParam of method.params) {
            // Try to find matching step parameter by name or semantic meaning
            const matchingStepParam = this.findMatchingStepParam(methodParam, stepParams, method);
            if (matchingStepParam) {
                args.push(matchingStepParam.name);
            }
        }

        return args.join(', ');
    }

    /**
     * Find the step parameter that matches a page method parameter
     */
    private findMatchingStepParam(
        methodParam: { name: string; type: string },
        stepParams: Array<{ name: string; type: string }>,
        method: PageMethod
    ): { name: string; type: string } | undefined {
        // Direct name match
        const directMatch = stepParams.find(sp => sp.name === methodParam.name);
        if (directMatch) {
            return directMatch;
        }

        // Semantic matching based on parameter purpose
        const paramName = methodParam.name.toLowerCase();

        // For text input values (username, password, etc.)
        if (paramName.includes('username') || paramName.includes('password') ||
            paramName.includes('value') || paramName.includes('text')) {
            const valueParam = stepParams.find(sp =>
                sp.name === 'value' || sp.name === 'text' ||
                sp.name.includes('username') || sp.name.includes('password')
            );
            if (valueParam) return valueParam;
        }

        // For expected text in assertions
        if (paramName.includes('expected') || paramName.includes('text')) {
            const expectedParam = stepParams.find(sp =>
                sp.name === 'expectedText' || sp.name.includes('expected')
            );
            if (expectedParam) return expectedParam;
        }

        // For URL parameters
        if (paramName.includes('url')) {
            const urlParam = stepParams.find(sp =>
                sp.name === 'pageName' || sp.name === 'url'
            );
            if (urlParam) return urlParam;
        }

        // For key press parameters
        if (paramName.includes('key')) {
            const keyParam = stepParams.find(sp => sp.name === 'key');
            if (keyParam) return keyParam;
        }

        // Default: return the first step param if there's only one page param
        if (method.params.length === 1 && stepParams.length > 0) {
            // Skip 'elementName' as it's usually just for step reusability
            const nonElementParam = stepParams.find(sp => sp.name !== 'elementName');
            if (nonElementParam) return nonElementParam;
            // If only elementName exists, still skip it for non-element-specific methods
            return undefined;
        }

        return undefined;
    }

    /**
     * Build feature file content with Scenario Outline and JSON Examples (data-driven pattern)
     */
    private buildFeatureContent(steps: string[], testData?: ReturnType<typeof TestDataExtractor.extract>): string {
        let content = `@smoke @regression @codegen\n`;
        content += `Feature: Complete Test Scenario\n`;
        content += `  Automated test scenario following the recorded flow\n`;
        content += `  Generated by CS Playwright Test Framework with Intelligence\n\n`;

        // Use Background for common setup if applicable
        content += `  Background:\n`;
        content += `    # Test data loaded from JSON Examples via currentRow\n\n`;

        // Use Scenario Outline for data-driven testing
        content += `  @fullFlow\n`;
        content += `  Scenario Outline: Execute recorded test flow\n`;
        content += `    # ============================================================\n`;
        content += `    # TEST DATA: Loaded from JSON Examples\n`;
        content += `    # ============================================================\n\n`;

        // Convert steps to use placeholders for data values
        // Use originalValue (not masked value) for replacement in feature file
        const placeholderMap = new Map<string, string>();
        if (testData) {
            for (const [key, value] of Object.entries(testData.data)) {
                // Use originalValue for replacement (handles sensitive fields correctly)
                const originalVal = value.originalValue ?? value.value;
                if (typeof originalVal === 'string') {
                    const placeholder = `<${key}>`;
                    placeholderMap.set(originalVal as string, placeholder);
                }
            }
        }

        // UI elements that should NOT be parameterized (navigation items, common buttons)
        const uiElementNames = new Set([
            'login', 'logout', 'submit', 'cancel', 'save', 'delete', 'edit',
            'add', 'remove', 'search', 'filter', 'reset', 'clear', 'close',
            'ok', 'yes', 'no', 'confirm', 'apply', 'next', 'previous', 'back',
            'home', 'admin', 'dashboard', 'settings', 'profile', 'menu',
            'time', 'leave', 'pim', 'recruitment', 'performance', 'directory',
            'maintenance', 'claim', 'buzz', 'my info', 'help'
        ]);

        for (const step of steps) {
            // Replace hardcoded values with placeholders
            let parameterizedStep = step;
            for (const [value, placeholder] of placeholderMap) {
                // Replace quoted values with placeholder (e.g., "admin" -> "<username>")
                // But only if the context is NOT a navigation element (link, button name)
                const quotedPattern = `"${value}"`;
                if (parameterizedStep.includes(quotedPattern)) {
                    // Check if this is a navigation context (link or button name)
                    const isNavContext = parameterizedStep.match(new RegExp(`click the ${quotedPattern} (link|button)\\b`, 'i')) ||
                                        parameterizedStep.match(new RegExp(`click the [^"]*${quotedPattern}[^"]* (link|button)\\b`, 'i'));
                    const isUiElement = uiElementNames.has(value.toLowerCase());

                    // Only skip replacement if it's BOTH a nav context AND a known UI element
                    if (!(isNavContext && isUiElement)) {
                        parameterizedStep = parameterizedStep.replace(quotedPattern, `"${placeholder}"`);
                    }
                }

                // Replace unquoted element names in steps (e.g., "the Disabled element" -> "the <disabled> element")
                // Only if it's NOT a known UI element name (navigation items shouldn't be parameterized)
                if (!uiElementNames.has(value.toLowerCase())) {
                    const unquotedPattern = new RegExp(`\\bthe ${this.escapeRegex(value)} (element|button|link|row|option)\\b`, 'gi');
                    parameterizedStep = parameterizedStep.replace(unquotedPattern, `the "${placeholder}" $1`);

                    // Also handle "I click the Value element" pattern
                    const clickPattern = new RegExp(`\\bclick the ${this.escapeRegex(value)}\\b`, 'gi');
                    parameterizedStep = parameterizedStep.replace(clickPattern, `click the "${placeholder}"`);

                    // Handle normalized versions for row names and similar (with different spacing/case)
                    const normalizedValue = value.toLowerCase().replace(/[-_]/g, ' ');
                    const normalizedStep = parameterizedStep.toLowerCase();
                    if (normalizedStep.includes(normalizedValue)) {
                        const flexPattern = this.escapeRegex(normalizedValue).replace(/\s+/g, '[\\s_-]+');
                        const flexRegex = new RegExp(`\\bthe (${flexPattern}) (element|button|link|row|option)\\b`, 'gi');
                        parameterizedStep = parameterizedStep.replace(flexRegex, `the "${placeholder}" $2`);
                    }
                }
            }
            content += `    ${parameterizedStep}\n`;
        }

        // Add JSON Examples declaration for data-driven testing
        content += `\n    Examples: {"type": "json", "source": "codegen/test/data/test-data.json", "path": "$", "filter": "runFlag=Yes"}\n`;

        return content;
    }
}
