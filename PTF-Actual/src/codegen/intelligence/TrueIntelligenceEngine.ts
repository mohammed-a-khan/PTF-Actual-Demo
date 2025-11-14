/**
 * TRUE INTELLIGENCE ENGINE
 *
 * This is NOT about fancy NLP algorithms or ML buzzwords.
 * This is about UNDERSTANDING what the user is trying to accomplish.
 *
 * Core Principles:
 * 1. Understand USER INTENT not just actions
 * 2. Group actions into MEANINGFUL workflows
 * 3. Generate code that HUMANS would write
 * 4. Create BUSINESS-READABLE test scenarios
 */

import { Action, DeepCodeAnalysis, IntentAnalysis } from '../types';
import { CSReporter } from '../../reporter/CSReporter';

export interface UserFlow {
    name: string;                    // "Login Flow", "Search Flow"
    intent: string;                  // "authenticate", "search", "navigate"
    actions: Action[];               // Raw actions in this flow
    startIndex: number;              // Where flow starts
    endIndex: number;                // Where flow ends
    description: string;             // Human-readable description
    outcome: 'success' | 'failure' | 'navigation' | 'unknown';
    dataInputs: Map<string, string>; // Field → Value
    expectedResult?: string;         // What should happen
}

export interface SemanticPageObject {
    name: string;                    // "LeaveManagement", "UserAdmin"
    module: string;                  // "Leave", "Admin", "PIM"
    elements: SemanticElement[];
    workflows: WorkflowMethod[];     // High-level methods
}

export interface SemanticElement {
    name: string;                    // "leaveTypeDropdown", "usernameSearchInput"
    purpose: string;                 // "select leave type", "search by username"
    locator: string;
    type: 'input' | 'button' | 'dropdown' | 'checkbox' | 'link' | 'text';
}

export interface WorkflowMethod {
    name: string;                    // "searchByLeaveType", "selectUser"
    description: string;
    parameters: Array<{name: string; type: string; purpose: string}>;
    steps: string[];                 // Human-readable steps
    frameworkCode: string;           // Actual implementation
}

export class TrueIntelligenceEngine {

    /**
     * PHASE 1: Understand what the user is ACTUALLY trying to do
     */
    public analyzeUserIntent(analysis: DeepCodeAnalysis): UserFlow[] {
        CSReporter.info('🧠 Analyzing user intent with TRUE intelligence...');

        const flows: UserFlow[] = [];
        const actions = analysis.actions;

        let currentFlow: Action[] = [];
        let currentIntent: string = 'unknown';
        let flowStart = 0;

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            const nextAction = actions[i + 1];

            // Detect flow boundaries
            if (this.isFlowBoundary(action, nextAction, currentIntent)) {
                // Save current flow
                if (currentFlow.length > 0) {
                    flows.push(this.createFlow(currentFlow, currentIntent, flowStart, i));
                }

                // Start new flow
                currentFlow = [action];
                currentIntent = this.detectIntent(action, nextAction);
                flowStart = i;
            } else {
                currentFlow.push(action);
            }
        }

        // Add last flow
        if (currentFlow.length > 0) {
            flows.push(this.createFlow(currentFlow, currentIntent, flowStart, actions.length - 1));
        }

        CSReporter.info(`✅ Identified ${flows.length} distinct user flows:`);
        flows.forEach((flow, i) => {
            CSReporter.info(`   ${i + 1}. ${flow.name} - ${flow.description}`);
        });

        return flows;
    }

    /**
     * Detect when a new flow begins
     */
    private isFlowBoundary(current: Action, next: Action | undefined, currentIntent: string): boolean {
        // Navigation links always start new flows
        if (current.type === 'click' &&
            current.target?.type === 'getByRole' &&
            current.target?.selector === 'link') {
            const linkName = current.target.options?.name || '';
            // Module navigation links
            if (['Leave', 'Admin', 'PIM', 'Time', 'Recruitment', 'Directory'].includes(linkName)) {
                return true;
            }
        }

        // Login flow → module navigation
        if (currentIntent === 'authenticate' && next?.type === 'click' && next.target?.type === 'getByRole') {
            return true;
        }

        // Search → selection
        if (current.type === 'click' && current.expression.includes('Search') &&
            next?.type === 'assertion') {
            return false; // Same flow
        }

        return false;
    }

    /**
     * Detect the intent of an action
     */
    private detectIntent(action: Action, next: Action | undefined): string {
        const expr = action.expression.toLowerCase();

        // Authentication
        if (expr.includes('username') || expr.includes('password') || expr.includes('login')) {
            return 'authenticate';
        }

        // Search
        if (expr.includes('search') || (action.type === 'fill' && next?.expression.includes('Search'))) {
            return 'search';
        }

        // Selection
        if (expr.includes('checkbox') || expr.includes('check') || expr.includes('select')) {
            return 'select';
        }

        // Navigation
        if (action.target?.type === 'getByRole' && action.target.selector === 'link') {
            return 'navigate';
        }

        return 'interact';
    }

    /**
     * Create a structured flow from actions
     */
    private createFlow(actions: Action[], intent: string, start: number, end: number): UserFlow {
        const dataInputs = new Map<string, string>();
        let expectedResult: string | undefined;
        let moduleName = '';

        // Extract data inputs
        for (const action of actions) {
            if (action.type === 'fill') {
                const fieldName = action.target?.options?.name || 'field';
                const value = action.args[0] as string;
                dataInputs.set(fieldName, value);
            }

            // Extract expected results from assertions
            if (action.type === 'assertion') {
                const textMatch = action.expression.match(/getByText\(['"]([^'"]+)['"]\)/);
                const headingMatch = action.expression.match(/getByRole\(['"]heading['"],\s*\{\s*name:\s*['"]([^'"]+)['"]/);

                if (textMatch) expectedResult = textMatch[1];
                else if (headingMatch) expectedResult = headingMatch[1];
            }

            // Extract module name from navigation
            if (action.target?.type === 'getByRole' && action.target.selector === 'link') {
                moduleName = action.target.options?.name || '';
            }
        }

        // Generate flow name and description
        const flowName = this.generateFlowName(intent, moduleName, dataInputs);
        const description = this.generateFlowDescription(intent, actions, moduleName, dataInputs);

        return {
            name: flowName,
            intent,
            actions,
            startIndex: start,
            endIndex: end,
            description,
            outcome: expectedResult ? 'success' : 'unknown',
            dataInputs,
            expectedResult
        };
    }

    /**
     * Generate intelligent flow name
     */
    private generateFlowName(intent: string, module: string, inputs: Map<string, string>): string {
        if (intent === 'authenticate') {
            return 'User Authentication';
        }

        if (intent === 'navigate') {
            return module ? `Navigate to ${module}` : 'Navigation';
        }

        if (intent === 'search') {
            const searchTerm = Array.from(inputs.values())[0];
            return module ? `Search in ${module}` : 'Search';
        }

        if (intent === 'select') {
            return module ? `Select item in ${module}` : 'Item Selection';
        }

        return 'User Interaction';
    }

    /**
     * Generate human-readable description
     */
    private generateFlowDescription(
        intent: string,
        actions: Action[],
        module: string,
        inputs: Map<string, string>
    ): string {
        if (intent === 'authenticate') {
            return 'User logs into the system with valid credentials';
        }

        if (intent === 'navigate') {
            return module ? `User navigates to the ${module} module` : 'User navigates through the application';
        }

        if (intent === 'search') {
            const searchValue = Array.from(inputs.values())[0] || 'criteria';
            return module ?
                `User searches for "${searchValue}" in the ${module} module` :
                `User performs a search with criteria "${searchValue}"`;
        }

        if (intent === 'select') {
            return 'User selects items from the list';
        }

        return 'User interacts with the application';
    }

    /**
     * PHASE 2: Generate semantic page objects based on flows
     */
    public generateSemanticPageObjects(flows: UserFlow[]): SemanticPageObject[] {
        const pageObjects: SemanticPageObject[] = [];
        const modules = new Set<string>();

        // Group flows by module
        for (const flow of flows) {
            if (flow.intent === 'navigate') {
                const module = flow.actions.find(a =>
                    a.target?.type === 'getByRole' && a.target.selector === 'link'
                )?.target?.options?.name;

                if (module) modules.add(module);
            }
        }

        // Create page objects for each module
        for (const module of modules) {
            const relevantFlows = flows.filter(f => {
                return f.name.includes(module) || f.description.includes(module);
            });

            const pageObject = this.createSemanticPageObject(module, relevantFlows);
            pageObjects.push(pageObject);
        }

        CSReporter.info(`✅ Generated ${pageObjects.length} semantic page objects`);

        return pageObjects;
    }

    /**
     * Create semantic page object with intelligent methods
     */
    private createSemanticPageObject(module: string, flows: UserFlow[]): SemanticPageObject {
        const elements: SemanticElement[] = [];
        const workflows: WorkflowMethod[] = [];

        // Extract unique elements from all flows
        const seenLocators = new Set<string>();

        for (const flow of flows) {
            for (const action of flow.actions) {
                if (action.target && !seenLocators.has(action.target.selector)) {
                    seenLocators.add(action.target.selector);

                    const element = this.createSemanticElement(action, flow);
                    if (element) {
                        elements.push(element);
                    }
                }
            }

            // Create workflow method for this flow
            const workflow = this.createWorkflowMethod(flow);
            if (workflow) {
                workflows.push(workflow);
            }
        }

        return {
            name: `${module}Page`,
            module,
            elements,
            workflows
        };
    }

    /**
     * Create semantic element with purpose
     */
    private createSemanticElement(action: Action, flow: UserFlow): SemanticElement | null {
        if (!action.target) return null;

        const target = action.target;
        let name = '';
        let purpose = '';
        let type: SemanticElement['type'] = 'text';

        // Determine element type and purpose
        if (target.type === 'getByRole') {
            const role = target.selector;
            const elementName = target.options?.name || '';

            if (role === 'textbox') {
                name = elementName.toLowerCase().replace(/\s+/g, '') + 'Input';
                purpose = `Enter ${elementName.toLowerCase()}`;
                type = 'input';
            } else if (role === 'button') {
                name = elementName.toLowerCase().replace(/\s+/g, '') + 'Button';
                purpose = `Click ${elementName}`;
                type = 'button';
            } else if (role === 'link') {
                name = elementName.toLowerCase().replace(/\s+/g, '') + 'Link';
                purpose = `Navigate to ${elementName}`;
                type = 'link';
            }
        } else if (target.type === 'getByText') {
            const text = target.selector;
            name = text.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() + 'Option';
            purpose = `Select "${text}"`;
            type = 'dropdown';
        } else if (target.type === 'locator') {
            const selector = target.selector;

            if (selector.includes('select') && selector.includes('icon')) {
                name = 'dropdownTrigger';
                purpose = 'Open dropdown menu';
                type = 'dropdown';
            } else if (selector.includes('checkbox') || selector.includes('check')) {
                name = 'selectionCheckbox';
                purpose = 'Select item';
                type = 'checkbox';
            }
        }

        if (!name) return null;

        return {
            name,
            purpose,
            locator: this.buildLocator(target),
            type
        };
    }

    /**
     * Create high-level workflow method
     */
    private createWorkflowMethod(flow: UserFlow): WorkflowMethod | null {
        if (flow.intent === 'navigate' || flow.intent === 'authenticate') {
            return null; // These are handled in Background/setup
        }

        const params: Array<{name: string; type: string; purpose: string}> = [];
        const steps: string[] = [];

        // Extract parameters from data inputs
        for (const [field, value] of flow.dataInputs.entries()) {
            params.push({
                name: field.toLowerCase().replace(/\s+/g, ''),
                type: 'string',
                purpose: `The ${field.toLowerCase()} to search for`
            });

            steps.push(`Enter ${field.toLowerCase()}`);
        }

        steps.push('Click search button');

        if (flow.expectedResult) {
            steps.push(`Verify "${flow.expectedResult}" is displayed`);
        }

        // Generate method name
        const methodName = flow.intent === 'search' ? 'searchBy' + params[0]?.name.charAt(0).toUpperCase() + params[0]?.name.slice(1) :
                          flow.intent === 'select' ? 'selectItem' : 'performAction';

        return {
            name: methodName,
            description: flow.description,
            parameters: params,
            steps,
            frameworkCode: this.generateFrameworkCode(flow, params)
        };
    }

    /**
     * Build proper locator
     */
    private buildLocator(target: any): string {
        if (target.type === 'getByRole') {
            if (target.options?.name) {
                return `role=${target.selector}[name="${target.options.name}"]`;
            }
            return `role=${target.selector}`;
        }

        if (target.type === 'getByText') {
            return `text=${target.selector}`;
        }

        return target.selector;
    }

    /**
     * Generate actual framework implementation code
     */
    private generateFrameworkCode(flow: UserFlow, params: any[]): string {
        let code = '';

        for (const action of flow.actions) {
            if (action.type === 'fill') {
                const paramName = params.find(p =>
                    action.target?.options?.name?.toLowerCase().includes(p.name)
                )?.name || 'value';

                code += `        await this.${action.target?.options?.name?.toLowerCase()}Input.fill(${paramName});\n`;
            } else if (action.type === 'click') {
                const elementName = this.getElementNameFromAction(action);
                code += `        await this.${elementName}.click();\n`;
            } else if (action.type === 'assertion') {
                code += `        await expect(this.page.getByText('${flow.expectedResult}')).toBeVisible();\n`;
            }
        }

        return code;
    }

    /**
     * Get element name from action
     */
    private getElementNameFromAction(action: Action): string {
        if (action.target?.type === 'getByRole') {
            const name = action.target.options?.name || 'element';
            return name.toLowerCase().replace(/\s+/g, '') + 'Button';
        }
        return 'element';
    }
}
