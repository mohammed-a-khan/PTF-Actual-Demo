/**
 * ARCHITECTURE ORGANIZER
 *
 * Organizes code generation into proper architecture:
 * 1. Detects shared components (NavigationComponent)
 * 2. Groups elements by page module
 * 3. Creates proper page object hierarchy
 * 4. Groups actions into high-level methods
 */

import { Action } from '../types';
import { Pattern } from './PatternRecognitionEngine';
import { ElementContext } from './ContextExtractor';
import { CSReporter } from '../../reporter/CSReporter';

export interface ComponentDefinition {
    name: string;
    type: 'navigation' | 'shared' | 'page-specific';
    elements: ElementDefinition[];
    methods: MethodDefinition[];
}

export interface ElementDefinition {
    name: string;
    selector: string;
    locatorType: string;
    options?: Record<string, any>;
    module?: string;
}

export interface MethodDefinition {
    name: string;
    purpose: string;
    parameters: ParameterDefinition[];
    actions: Action[];
    patterns: Pattern[];
    returnType: 'Promise<void>';
    gherkinStep?: string;
}

export interface ParameterDefinition {
    name: string;
    type: string;
    defaultValue?: string;
}

export interface PageObjectDefinition {
    className: string;
    module: string;
    extends: string;
    components: ComponentDefinition[];
    elements: ElementDefinition[];
    methods: MethodDefinition[];
}

export interface ArchitectureOutput {
    baseComponent?: ComponentDefinition; // OrangeHRMBasePage
    navigationComponent?: ComponentDefinition; // NavigationComponent
    pageObjects: PageObjectDefinition[];
    stepDefinitions: StepDefinitionFile[];
    features: FeatureFile[];
}

export interface StepDefinitionFile {
    className: string;
    module: string;
    methods: StepMethodDefinition[];
}

export interface StepMethodDefinition {
    decoratorPattern: string;
    methodName: string;
    parameters: ParameterDefinition[];
    implementation: string;
}

export interface FeatureFile {
    name: string;
    description: string;
    tags: string[];
    scenarios: ScenarioDefinition[];
}

export interface ScenarioDefinition {
    name: string;
    tags: string[];
    steps: string[];
}

export class ArchitectureOrganizer {

    /**
     * Organize all intelligence into proper architecture
     */
    public organize(
        actions: Action[],
        patterns: Pattern[],
        contexts: Map<Action, ElementContext>,
        elements: Map<string, ElementDefinition>,
        methods: MethodDefinition[]
    ): ArchitectureOutput {
        CSReporter.info('📐 Organizing code architecture...');

        // Detect shared components
        const navigationComponent = this.detectNavigationComponent(actions, contexts, elements);

        // Group actions by page module
        const moduleGroups = this.groupActionsByModule(actions, contexts);

        // Create page objects for each module
        const pageObjects = this.createPageObjects(moduleGroups, elements, methods, patterns);

        // Create step definitions
        const stepDefinitions = this.createStepDefinitions(pageObjects, methods);

        // Create feature files
        const features = this.createFeatureFiles(pageObjects, patterns, methods);

        CSReporter.info(`✅ Architecture organized:`);
        CSReporter.info(`   - Navigation component: ${navigationComponent ? 'Yes' : 'No'}`);
        CSReporter.info(`   - Page objects: ${pageObjects.length}`);
        CSReporter.info(`   - Step definition files: ${stepDefinitions.length}`);
        CSReporter.info(`   - Feature files: ${features.length}`);

        return {
            navigationComponent,
            pageObjects,
            stepDefinitions,
            features
        };
    }

    /**
     * Detect navigation component (shared across all pages)
     */
    private detectNavigationComponent(
        actions: Action[],
        contexts: Map<Action, ElementContext>,
        elements: Map<string, ElementDefinition>
    ): ComponentDefinition | undefined {
        // Find all navigation link clicks
        const navigationLinks: ElementDefinition[] = [];
        const navigationModules = ['Admin', 'PIM', 'Leave', 'Time', 'Recruitment',
                                   'Performance', 'Dashboard', 'Directory', 'Maintenance'];

        for (const [action, context] of contexts.entries()) {
            if (action.type === 'click' &&
                action.target?.type === 'getByRole' &&
                action.target.selector === 'link') {

                const linkName = action.target.options?.name || '';
                const isModuleNav = navigationModules.some(m => linkName.includes(m));

                if (isModuleNav) {
                    const elementName = linkName.toLowerCase().replace(/\s+/g, '') + 'Link';
                    const element: ElementDefinition = {
                        name: elementName,
                        selector: 'link',
                        locatorType: 'getByRole',
                        options: { name: linkName }
                    };

                    // Avoid duplicates
                    if (!navigationLinks.some(e => e.name === elementName)) {
                        navigationLinks.push(element);
                    }
                }
            }
        }

        if (navigationLinks.length === 0) return undefined;

        // Create navigateToModule method
        const navigateMethod: MethodDefinition = {
            name: 'navigateToModule',
            purpose: 'Navigate to a module in the application',
            parameters: [
                {
                    name: 'module',
                    type: navigationLinks.map(e => `'${e.options?.name}'`).join(' | ')
                }
            ],
            actions: [],
            patterns: [],
            returnType: 'Promise<void>'
        };

        return {
            name: 'NavigationComponent',
            type: 'navigation',
            elements: navigationLinks,
            methods: [navigateMethod]
        };
    }

    /**
     * Group actions by page module
     */
    private groupActionsByModule(
        actions: Action[],
        contexts: Map<Action, ElementContext>
    ): Map<string, Action[]> {
        const groups = new Map<string, Action[]>();

        for (const [action, context] of contexts.entries()) {
            const module = context.pageModule || 'Unknown';

            if (!groups.has(module)) {
                groups.set(module, []);
            }

            groups.get(module)!.push(action);
        }

        return groups;
    }

    /**
     * Create page objects for each module
     */
    private createPageObjects(
        moduleGroups: Map<string, Action[]>,
        elements: Map<string, ElementDefinition>,
        methods: MethodDefinition[],
        patterns: Pattern[]
    ): PageObjectDefinition[] {
        const pageObjects: PageObjectDefinition[] = [];

        for (const [module, actions] of moduleGroups.entries()) {
            // Skip navigation component elements
            if (module === 'Unknown') continue;

            // Get elements for this module
            const moduleElements = Array.from(elements.values()).filter(e => {
                // Include elements that don't have a module (page-specific)
                // OR elements that match this module
                return !e.module || e.module === module;
            });

            // Get methods for this module
            const moduleMethods = methods.filter(m => {
                // Check if MAJORITY of actions in method belong to this module
                const moduleActionCount = m.actions.filter(a => actions.includes(a)).length;
                const totalActions = m.actions.length;

                // Method belongs to this module if >50% of its actions are from this module
                return moduleActionCount > (totalActions / 2);
            });

            // Generate class name
            const className = this.generatePageClassName(module);

            pageObjects.push({
                className,
                module,
                extends: 'CSBasePage',
                components: [],
                elements: moduleElements,
                methods: moduleMethods
            });
        }

        return pageObjects;
    }

    /**
     * Create step definition files
     */
    private createStepDefinitions(
        pageObjects: PageObjectDefinition[],
        methods: MethodDefinition[]
    ): StepDefinitionFile[] {
        const stepFiles: StepDefinitionFile[] = [];

        // Create shared authentication steps
        const authMethods = methods.filter(m =>
            m.purpose.includes('login') || m.purpose.includes('authenticate')
        );

        if (authMethods.length > 0) {
            stepFiles.push({
                className: 'AuthenticationSteps',
                module: 'Authentication',
                methods: authMethods.map(m => this.createStepMethod(m, 'Login'))
            });
        }

        // Create shared navigation steps
        stepFiles.push({
            className: 'NavigationSteps',
            module: 'Navigation',
            methods: [{
                decoratorPattern: '^I navigate to the (.*) page$',
                methodName: 'navigateToPage',
                parameters: [{ name: 'pageName', type: 'string' }],
                implementation: 'await this.navigation.navigateToModule(pageName);'
            }]
        });

        // Create module-specific step files
        for (const page of pageObjects) {
            if (page.methods.length === 0) continue;

            const stepMethods = page.methods
                .filter(m => m.gherkinStep) // Only methods with Gherkin steps
                .map(m => this.createStepMethod(m, page.module));

            if (stepMethods.length > 0) {
                stepFiles.push({
                    className: this.generateStepClassName(page.module),
                    module: page.module,
                    methods: stepMethods
                });
            }
        }

        return stepFiles;
    }

    /**
     * Create step method definition from method - FIXED to call page object, not recursive!
     */
    private createStepMethod(method: MethodDefinition, module: string): StepMethodDefinition {
        // Convert Gherkin step to Cucumber expression (NOT regex!)
        const pattern = this.gherkinToCucumberExpression(method.gherkinStep || '');

        // Generate page variable name (e.g., Admin -> adminUsersPage)
        const pageVarName = this.generatePageVarName(module);

        return {
            decoratorPattern: pattern,
            methodName: method.name,
            parameters: method.parameters,
            implementation: `await this.${pageVarName}.${method.name}(${method.parameters.map(p => p.name).join(', ')});`
        };
    }

    /**
     * Convert Gherkin step to Cucumber expression (NOT regex!)
     */
    private gherkinToCucumberExpression(gherkin: string): string {
        // Remove Given/When/Then
        let pattern = gherkin.replace(/^(Given|When|Then|And|But)\s+/i, '');

        // Replace quoted strings with {string} Cucumber expression
        pattern = pattern.replace(/"([^"]+)"/g, '{string}');

        return pattern;
    }

    /**
     * Generate page variable name from module
     */
    private generatePageVarName(module: string): string {
        const className = this.generatePageClassName(module);
        return className.charAt(0).toLowerCase() + className.slice(1);
    }

    /**
     * Create feature files from scenarios
     */
    private createFeatureFiles(
        pageObjects: PageObjectDefinition[],
        patterns: Pattern[],
        methods: MethodDefinition[]
    ): FeatureFile[] {
        const features: FeatureFile[] = [];

        // Group patterns by module
        const patternsByModule = new Map<string, Pattern[]>();

        for (const pattern of patterns) {
            // Determine module from pattern data
            let module = 'Unknown';

            if (pattern.type === 'login') {
                module = 'Authentication';
            } else if (pattern.type === 'navigation') {
                module = pattern.data.targetModule || 'Navigation';
            } else {
                // Find module from associated methods
                const method = methods.find(m => m.patterns.includes(pattern));
                if (method) {
                    const page = pageObjects.find(p => p.methods.includes(method));
                    if (page) {
                        module = page.module;
                    }
                }
            }

            if (!patternsByModule.has(module)) {
                patternsByModule.set(module, []);
            }
            patternsByModule.get(module)!.push(pattern);
        }

        // Create ONE feature with ALL scenarios (not separate features per module!)
        const allScenarios: ScenarioDefinition[] = [];
        const allTags = new Set<string>();

        for (const [module, modulePatterns] of patternsByModule.entries()) {
            const scenarios = this.createScenarios(module, modulePatterns, methods);
            allScenarios.push(...scenarios);
            allTags.add(this.moduleToTag(module));
        }

        // Create single comprehensive feature
        if (allScenarios.length > 0) {
            features.push({
                name: 'End-to-End Test Suite',
                description: 'Complete workflow test covering multiple modules and operations',
                tags: Array.from(allTags),
                scenarios: allScenarios
            });
        }

        return features;
    }

    /**
     * Create scenarios from patterns
     */
    private createScenarios(
        module: string,
        patterns: Pattern[],
        methods: MethodDefinition[]
    ): ScenarioDefinition[] {
        const scenarios: ScenarioDefinition[] = [];

        // Group consecutive patterns into scenarios
        let currentScenario: string[] = [];
        let scenarioName = '';

        for (const pattern of patterns) {
            // Find methods that use this pattern
            const method = methods.find(m => m.patterns.includes(pattern));

            if (method && method.gherkinStep) {
                currentScenario.push(method.gherkinStep);

                if (!scenarioName) {
                    scenarioName = this.generateScenarioName(pattern, module);
                }
            }

            // End scenario if this is a terminal pattern (modal, assertion)
            if (pattern.type === 'modal' || currentScenario.length >= 5) {
                if (currentScenario.length > 0) {
                    scenarios.push({
                        name: scenarioName || `Perform operation in ${module}`,
                        tags: [this.moduleToTag(module), this.patternToTag(pattern.type)],
                        steps: currentScenario
                    });
                }

                currentScenario = [];
                scenarioName = '';
            }
        }

        // Add any remaining scenario
        if (currentScenario.length > 0) {
            scenarios.push({
                name: scenarioName || `Perform operation in ${module}`,
                tags: [this.moduleToTag(module)],
                steps: currentScenario
            });
        }

        return scenarios;
    }

    /**
     * Generate page class name
     */
    private generatePageClassName(module: string): string {
        switch (module) {
            case 'Admin':
                return 'AdminUsersPage';
            case 'PIM':
                return 'PIMEmployeesPage';
            case 'Leave':
                return 'LeaveManagementPage';
            case 'Time':
                return 'TimeManagementPage';
            case 'Login':
                return 'LoginPage';
            case 'Dashboard':
                return 'DashboardPage';
            case 'Directory':
                return 'EmployeeDirectoryPage';
            default:
                return `${module}Page`;
        }
    }

    /**
     * Generate step definition class name
     */
    private generateStepClassName(module: string): string {
        switch (module) {
            case 'Admin':
                return 'AdminUsersSteps';
            case 'PIM':
                return 'PIMEmployeesSteps';
            case 'Leave':
                return 'LeaveManagementSteps';
            case 'Time':
                return 'TimeManagementSteps';
            default:
                return `${module}Steps`;
        }
    }

    /**
     * Generate feature name
     */
    private generateFeatureName(module: string): string {
        switch (module.toLowerCase()) {
            case 'authentication':
                return 'User Authentication';
            case 'admin':
                return 'Admin User Management';
            case 'pim':
                return 'Employee Information Management';
            case 'leave':
                return 'Leave Management';
            case 'time':
                return 'Time Tracking';
            default:
                return `${module} Management`;
        }
    }

    /**
     * Generate feature description
     */
    private generateFeatureDescription(module: string): string {
        return `As a user, I want to manage ${module.toLowerCase()} so that I can perform my daily tasks`;
    }

    /**
     * Generate scenario name from pattern
     */
    private generateScenarioName(pattern: Pattern, module: string): string {
        switch (pattern.type) {
            case 'search':
                return `Search for records in ${module}`;
            case 'dropdown':
                const option = pattern.data.optionText;
                return `Filter by ${option} status`;
            case 'modal':
                if (pattern.data.action === 'cancel') {
                    return `Cancel operation in ${module}`;
                }
                return `Confirm operation in ${module}`;
            case 'navigation':
                return `Navigate to ${pattern.data.targetModule}`;
            case 'login':
                return `User logs into the system`;
            default:
                return `Perform operation in ${module}`;
        }
    }

    /**
     * Convert module to tag
     */
    private moduleToTag(module: string): string {
        return `@${module.toLowerCase().replace(/\s+/g, '-')}`;
    }

    /**
     * Convert pattern type to tag
     */
    private patternToTag(patternType: string): string {
        return `@${patternType}`;
    }

    /**
     * Check if element should be in navigation component
     */
    public isNavigationElement(element: ElementDefinition): boolean {
        if (element.locatorType !== 'getByRole' || element.selector !== 'link') {
            return false;
        }

        const navigationModules = ['Admin', 'PIM', 'Leave', 'Time', 'Recruitment',
                                   'Performance', 'Dashboard', 'Directory', 'Maintenance'];

        const linkName = element.options?.name || '';
        return navigationModules.some(m => linkName.includes(m));
    }

    /**
     * Group methods into higher-level workflows
     */
    public groupMethodsIntoWorkflows(methods: MethodDefinition[]): MethodDefinition[] {
        // Combine low-level methods (click, fill) into high-level workflows (search, filter)
        const workflows: MethodDefinition[] = [];

        // This is already handled by pattern recognition
        // Methods created from patterns ARE high-level workflows

        return methods;
    }
}
