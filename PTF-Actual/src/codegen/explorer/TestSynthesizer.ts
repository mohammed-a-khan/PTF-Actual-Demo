/**
 * Test Synthesizer
 * Generates test files from exploration results
 *
 * @module TestSynthesizer
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    ExplorationResult,
    ApplicationState,
    StateTransition,
    InteractiveElement,
    FormDescriptor,
    GeneratedWorkflow,
    WorkflowStep,
    CapturedAPI,
} from './types';

export interface SynthesizerConfig {
    outputDir: string;
    projectName: string;
    generateBDD: boolean;
    generateSpec: boolean;
    generatePageObjects: boolean;
    includeAPITests: boolean;
}

export class TestSynthesizer {
    private config: SynthesizerConfig;

    constructor(config: SynthesizerConfig) {
        this.config = config;

        // Ensure output directories exist
        const dirs = ['features', 'pages', 'steps', 'specs', 'api'];
        for (const dir of dirs) {
            const fullPath = path.join(config.outputDir, dir);
            if (!fs.existsSync(fullPath)) {
                fs.mkdirSync(fullPath, { recursive: true });
            }
        }
    }

    /**
     * Generate all test files from exploration result
     */
    async synthesize(result: ExplorationResult): Promise<string[]> {
        const generatedFiles: string[] = [];

        // 1. Identify workflows
        const workflows = this.identifyWorkflows(result);

        // 2. Generate page objects
        if (this.config.generatePageObjects) {
            const pageObjectFiles = await this.generatePageObjects(result.states);
            generatedFiles.push(...pageObjectFiles);
        }

        // 3. Generate BDD features
        if (this.config.generateBDD) {
            const featureFiles = await this.generateFeatureFiles(workflows, result);
            generatedFiles.push(...featureFiles);

            const stepFiles = await this.generateStepDefinitions(workflows, result);
            generatedFiles.push(...stepFiles);
        }

        // 4. Generate spec files
        if (this.config.generateSpec) {
            const specFiles = await this.generateSpecFiles(workflows, result);
            generatedFiles.push(...specFiles);
        }

        // 5. Generate API tests
        if (this.config.includeAPITests && result.apis.length > 0) {
            const apiTestFiles = await this.generateAPITests(result.apis);
            generatedFiles.push(...apiTestFiles);
        }

        return generatedFiles;
    }

    /**
     * Identify workflows from exploration data
     */
    private identifyWorkflows(result: ExplorationResult): GeneratedWorkflow[] {
        const workflows: GeneratedWorkflow[] = [];

        // Group transitions by pattern
        const transitionsByFromState = new Map<string, StateTransition[]>();
        for (const transition of result.transitions) {
            const existing = transitionsByFromState.get(transition.fromStateId) || [];
            existing.push(transition);
            transitionsByFromState.set(transition.fromStateId, existing);
        }

        // Identify login workflow
        const loginWorkflow = this.identifyLoginWorkflow(result);
        if (loginWorkflow) workflows.push(loginWorkflow);

        // Identify CRUD workflows
        const crudWorkflows = this.identifyCRUDWorkflows(result);
        workflows.push(...crudWorkflows);

        // Identify search workflows
        const searchWorkflows = this.identifySearchWorkflows(result);
        workflows.push(...searchWorkflows);

        // Identify navigation workflows
        const navigationWorkflows = this.identifyNavigationWorkflows(result);
        workflows.push(...navigationWorkflows);

        // If no specific workflows found, generate generic interaction workflows from states
        if (workflows.length === 0) {
            const genericWorkflows = this.generateGenericWorkflows(result);
            workflows.push(...genericWorkflows);
        }

        return workflows;
    }

    /**
     * Generate generic workflows when no specific patterns are detected
     * This ensures BDD features are always generated with meaningful content
     */
    private generateGenericWorkflows(result: ExplorationResult): GeneratedWorkflow[] {
        const workflows: GeneratedWorkflow[] = [];

        for (const state of result.states) {
            // Skip states with too few elements
            if (state.interactiveElements.length < 2) continue;

            // Generate page exploration workflow
            const pageWorkflow = this.generatePageExplorationWorkflow(state);
            if (pageWorkflow) {
                workflows.push(pageWorkflow);
            }

            // Generate form interaction workflow for each form
            for (const form of state.forms) {
                const formWorkflow = this.generateFormWorkflow(state, form);
                if (formWorkflow) {
                    workflows.push(formWorkflow);
                }
            }
        }

        return workflows;
    }

    /**
     * Generate a page exploration workflow
     */
    private generatePageExplorationWorkflow(state: ApplicationState): GeneratedWorkflow | null {
        const steps: WorkflowStep[] = [];
        let order = 1;

        // Navigate to page step
        steps.push({
            order: order++,
            action: 'navigate',
            target: state.url,
            gherkinStep: `Given I navigate to the ${state.pageType || 'page'}`,
        });

        // Verify key elements are visible
        const keyElements = state.interactiveElements
            .filter(el => el.isVisible && ['button', 'link', 'input'].includes(el.type))
            .slice(0, 5);

        for (const el of keyElements) {
            const elementDesc = el.text || el.label || el.ariaLabel || el.type;
            steps.push({
                order: order++,
                action: 'wait',
                target: this.getLocatorString(el),
                gherkinStep: `Then I should see the ${elementDesc}`,
                assertion: {
                    type: 'visibility',
                    target: this.getLocatorString(el),
                    expected: true,
                    confidence: 85,
                    gherkinStep: `And the ${elementDesc} should be visible`,
                    playwrightCode: `await expect(page.locator('${this.getLocatorString(el)}')).toBeVisible()`,
                },
            });
        }

        // Interact with primary buttons/links
        const primaryButtons = state.interactiveElements
            .filter(el => el.type === 'button' && el.purpose !== 'delete')
            .slice(0, 2);

        for (const btn of primaryButtons) {
            const btnDesc = btn.text || btn.label || 'button';
            steps.push({
                order: order++,
                action: 'click',
                target: this.getLocatorString(btn),
                gherkinStep: `When I click the ${btnDesc}`,
            });
        }

        return {
            id: `explore-${state.id}`,
            name: `Explore ${state.title || state.pageType || 'Page'}`,
            description: `Verify page elements and basic interactions on ${state.title || state.url}`,
            type: 'exploration',
            steps,
            testData: {},
        };
    }

    /**
     * Generate a form interaction workflow
     */
    private generateFormWorkflow(state: ApplicationState, form: FormDescriptor): GeneratedWorkflow | null {
        if (form.fields.length === 0) return null;

        const steps: WorkflowStep[] = [];
        let order = 1;
        const testData: Record<string, unknown> = {};

        // Navigate step
        steps.push({
            order: order++,
            action: 'navigate',
            target: state.url,
            gherkinStep: `Given I am on the ${form.formType || 'form'} page`,
        });

        // Fill each form field
        for (const field of form.fields) {
            const fieldName = field.label || field.placeholder || field.fieldType || 'field';
            const dataKey = fieldName.toLowerCase().replace(/[^a-z0-9]/g, '_');
            const sampleValue = this.generateSampleData(field.fieldType || 'text');

            testData[dataKey] = sampleValue;

            if (field.type === 'input' || field.type === 'textarea') {
                steps.push({
                    order: order++,
                    action: 'fill',
                    target: this.getLocatorString(field),
                    value: `{${dataKey}}`,
                    gherkinStep: `When I enter "{${dataKey}}" in the ${fieldName} field`,
                });
            } else if (field.type === 'select') {
                steps.push({
                    order: order++,
                    action: 'select',
                    target: this.getLocatorString(field),
                    value: `{${dataKey}}`,
                    gherkinStep: `And I select "{${dataKey}}" from the ${fieldName} dropdown`,
                });
            } else if (field.type === 'checkbox') {
                steps.push({
                    order: order++,
                    action: 'check',
                    target: this.getLocatorString(field),
                    gherkinStep: `And I check the ${fieldName} checkbox`,
                });
            }
        }

        // Submit form
        if (form.submitButton) {
            const submitText = form.submitButton.text || 'Submit';
            steps.push({
                order: order++,
                action: 'click',
                target: this.getLocatorString(form.submitButton),
                gherkinStep: `When I click the ${submitText} button`,
            });

            // Success assertion
            steps.push({
                order: order++,
                action: 'wait',
                target: 'response',
                gherkinStep: 'Then the form should be submitted successfully',
                assertion: {
                    type: 'visibility',
                    target: '.success, [role="alert"], .notification',
                    expected: true,
                    confidence: 60,
                    gherkinStep: 'And I should see a confirmation message',
                    playwrightCode: `await expect(page.locator('.success, [role="alert"], .notification')).toBeVisible({ timeout: 10000 })`,
                },
            });
        }

        const formTitle = form.formType
            ? `${form.formType.charAt(0).toUpperCase() + form.formType.slice(1)} Form`
            : `Form on ${state.title || 'page'}`;

        return {
            id: `form-${form.id}`,
            name: `Submit ${formTitle}`,
            description: `Verify ${formTitle} can be filled and submitted`,
            type: 'form',
            steps,
            testData,
        };
    }

    /**
     * Identify login workflow
     */
    private identifyLoginWorkflow(result: ExplorationResult): GeneratedWorkflow | null {
        const loginState = result.states.find(s => s.pageType === 'login');
        if (!loginState) return null;

        const loginForm = loginState.forms.find(f => f.formType === 'login');
        if (!loginForm) return null;

        const steps: WorkflowStep[] = [];
        let order = 1;

        // Find username field
        const usernameField = loginForm.fields.find(f =>
            f.fieldType === 'username' || f.fieldType === 'email'
        );
        if (usernameField) {
            steps.push({
                order: order++,
                action: 'fill',
                target: this.getLocatorString(usernameField),
                value: '{username}',
                gherkinStep: 'When I enter "{username}" in the username field',
            });
        }

        // Find password field
        const passwordField = loginForm.fields.find(f => f.fieldType === 'password');
        if (passwordField) {
            steps.push({
                order: order++,
                action: 'fill',
                target: this.getLocatorString(passwordField),
                value: '{password}',
                gherkinStep: 'And I enter "{password}" in the password field',
            });
        }

        // Submit button
        if (loginForm.submitButton) {
            steps.push({
                order: order++,
                action: 'click',
                target: this.getLocatorString(loginForm.submitButton),
                gherkinStep: 'And I click the login button',
            });
        }

        // Add assertion
        steps.push({
            order: order++,
            action: 'wait',
            target: 'navigation',
            gherkinStep: 'Then I should be logged in successfully',
            assertion: {
                type: 'url',
                target: 'page',
                expected: '/dashboard',
                confidence: 80,
                gherkinStep: 'Then I should be redirected to the dashboard',
                playwrightCode: "await expect(page).toHaveURL(/dashboard/)",
            },
        });

        return {
            id: 'login',
            name: 'User Login',
            description: 'Verify user can log in with valid credentials',
            type: 'login',
            steps,
            testData: {
                username: 'testuser',
                password: 'testpass',
            },
        };
    }

    /**
     * Identify CRUD workflows
     */
    private identifyCRUDWorkflows(result: ExplorationResult): GeneratedWorkflow[] {
        const workflows: GeneratedWorkflow[] = [];

        // Find list states (likely have CRUD operations)
        const listStates = result.states.filter(s => s.pageType === 'list');

        for (const listState of listStates) {
            const entity = listState.businessEntity || 'Item';

            // Find add button
            const addButton = listState.interactiveElements.find(e => e.purpose === 'add');
            if (addButton) {
                // Check if there's a form state connected
                const addTransition = result.transitions.find(t =>
                    t.fromStateId === listState.id &&
                    t.action.elementId === addButton.id
                );

                if (addTransition) {
                    const formState = result.states.find(s => s.id === addTransition.toStateId);
                    if (formState && formState.forms.length > 0) {
                        const createWorkflow = this.buildCRUDCreateWorkflow(
                            entity,
                            listState,
                            formState,
                            addButton
                        );
                        if (createWorkflow) workflows.push(createWorkflow);
                    }
                }
            }

            // Find edit button (in table actions)
            const editButton = listState.interactiveElements.find(e => e.purpose === 'edit');
            if (editButton) {
                const editWorkflow: GeneratedWorkflow = {
                    id: `edit-${entity.toLowerCase()}`,
                    name: `Edit ${entity}`,
                    description: `Verify user can edit an existing ${entity}`,
                    type: 'crud',
                    steps: [
                        {
                            order: 1,
                            action: 'click',
                            target: this.getLocatorString(editButton),
                            gherkinStep: `When I click the edit button for a ${entity}`,
                        },
                        {
                            order: 2,
                            action: 'wait',
                            target: 'form',
                            gherkinStep: 'Then the edit form should be displayed',
                        },
                    ],
                    testData: {},
                };
                workflows.push(editWorkflow);
            }

            // Find delete button
            const deleteButton = listState.interactiveElements.find(e => e.purpose === 'delete');
            if (deleteButton) {
                const deleteWorkflow: GeneratedWorkflow = {
                    id: `delete-${entity.toLowerCase()}`,
                    name: `Delete ${entity}`,
                    description: `Verify user can delete an existing ${entity}`,
                    type: 'crud',
                    steps: [
                        {
                            order: 1,
                            action: 'click',
                            target: this.getLocatorString(deleteButton),
                            gherkinStep: `When I click the delete button for a ${entity}`,
                        },
                        {
                            order: 2,
                            action: 'click',
                            target: 'confirm-button',
                            gherkinStep: 'And I confirm the deletion',
                        },
                        {
                            order: 3,
                            action: 'wait',
                            target: 'success-message',
                            gherkinStep: `Then the ${entity} should be deleted successfully`,
                        },
                    ],
                    testData: {},
                };
                workflows.push(deleteWorkflow);
            }
        }

        return workflows;
    }

    /**
     * Build CRUD create workflow
     */
    private buildCRUDCreateWorkflow(
        entity: string,
        listState: ApplicationState,
        formState: ApplicationState,
        addButton: InteractiveElement
    ): GeneratedWorkflow | null {
        const form = formState.forms[0];
        if (!form) return null;

        const steps: WorkflowStep[] = [];
        let order = 1;

        // Click add button
        steps.push({
            order: order++,
            action: 'click',
            target: this.getLocatorString(addButton),
            gherkinStep: `When I click the Add ${entity} button`,
        });

        // Fill form fields
        for (const field of form.fields) {
            if (field.type === 'input' || field.type === 'textarea') {
                const fieldName = field.label || field.placeholder || field.fieldType || 'field';
                steps.push({
                    order: order++,
                    action: 'fill',
                    target: this.getLocatorString(field),
                    value: `{${fieldName.toLowerCase().replace(/\s+/g, '_')}}`,
                    gherkinStep: `And I enter "{${fieldName}}" in the ${fieldName} field`,
                });
            } else if (field.type === 'select') {
                const fieldName = field.label || 'dropdown';
                steps.push({
                    order: order++,
                    action: 'select',
                    target: this.getLocatorString(field),
                    value: `{${fieldName.toLowerCase().replace(/\s+/g, '_')}}`,
                    gherkinStep: `And I select "{${fieldName}}" from the dropdown`,
                });
            } else if (field.type === 'checkbox') {
                steps.push({
                    order: order++,
                    action: 'check',
                    target: this.getLocatorString(field),
                    gherkinStep: `And I check the ${field.label || 'checkbox'}`,
                });
            }
        }

        // Submit form
        if (form.submitButton) {
            steps.push({
                order: order++,
                action: 'click',
                target: this.getLocatorString(form.submitButton),
                gherkinStep: 'And I click the Save button',
            });
        }

        // Assertion
        steps.push({
            order: order++,
            action: 'wait',
            target: 'success',
            gherkinStep: `Then the ${entity} should be created successfully`,
            assertion: {
                type: 'visibility',
                target: 'success-message',
                expected: true,
                confidence: 75,
                gherkinStep: 'And a success message should be displayed',
                playwrightCode: "await expect(page.locator('.success, [role=\"alert\"]')).toBeVisible()",
            },
        });

        // Generate test data
        const testData: Record<string, unknown> = {};
        for (const field of form.fields) {
            const key = (field.label || field.placeholder || field.fieldType || 'field')
                .toLowerCase()
                .replace(/\s+/g, '_');
            testData[key] = this.generateSampleData(field.fieldType || 'text');
        }

        return {
            id: `create-${entity.toLowerCase()}`,
            name: `Create ${entity}`,
            description: `Verify user can create a new ${entity}`,
            type: 'crud',
            steps,
            testData,
        };
    }

    /**
     * Identify search workflows
     */
    private identifySearchWorkflows(result: ExplorationResult): GeneratedWorkflow[] {
        const workflows: GeneratedWorkflow[] = [];

        const searchStates = result.states.filter(s =>
            s.pageType === 'search' ||
            s.interactiveElements.some(e => e.purpose === 'search' || e.fieldType === 'search')
        );

        for (const state of searchStates) {
            const searchField = state.interactiveElements.find(e =>
                e.fieldType === 'search' || e.purpose === 'search'
            );

            if (searchField) {
                workflows.push({
                    id: `search-${state.id}`,
                    name: 'Search Functionality',
                    description: 'Verify search functionality works correctly',
                    type: 'search',
                    steps: [
                        {
                            order: 1,
                            action: 'fill',
                            target: this.getLocatorString(searchField),
                            value: '{searchTerm}',
                            gherkinStep: 'When I search for "{searchTerm}"',
                        },
                        {
                            order: 2,
                            action: 'keyboard',
                            target: 'Enter',
                            gherkinStep: 'And I press Enter',
                        },
                        {
                            order: 3,
                            action: 'wait',
                            target: 'results',
                            gherkinStep: 'Then search results should be displayed',
                        },
                    ],
                    testData: {
                        searchTerm: 'test',
                    },
                });
            }
        }

        return workflows;
    }

    /**
     * Identify navigation workflows
     */
    private identifyNavigationWorkflows(result: ExplorationResult): GeneratedWorkflow[] {
        const workflows: GeneratedWorkflow[] = [];

        // Find main navigation elements
        for (const state of result.states) {
            const navLinks = state.interactiveElements.filter(e =>
                e.type === 'link' && e.purpose === 'navigate'
            );

            if (navLinks.length > 3) {
                const steps: WorkflowStep[] = navLinks.slice(0, 5).map((link, i) => ({
                    order: i + 1,
                    action: 'click' as const,
                    target: this.getLocatorString(link),
                    gherkinStep: `When I click on "${link.text || 'link'}"`,
                    assertion: {
                        type: 'url' as const,
                        target: 'page',
                        expected: link.attributes['href'] || '',
                        confidence: 70,
                        gherkinStep: 'Then I should be navigated to the correct page',
                        playwrightCode: `await expect(page).toHaveURL(/${link.attributes['href'] || ''}/)`,
                    },
                }));

                workflows.push({
                    id: `navigation-${state.id}`,
                    name: 'Main Navigation',
                    description: 'Verify main navigation links work correctly',
                    type: 'navigation',
                    steps,
                    testData: {},
                });

                break; // Only one navigation workflow needed
            }
        }

        return workflows;
    }

    /**
     * Generate page object files
     */
    private async generatePageObjects(states: ApplicationState[]): Promise<string[]> {
        const files: string[] = [];

        for (const state of states) {
            if (state.interactiveElements.length < 3) continue;

            const pageName = this.generatePageName(state);
            const fileName = `${pageName}.page.ts`;
            const filePath = path.join(this.config.outputDir, 'pages', fileName);

            const content = this.generatePageObjectContent(state, pageName);
            fs.writeFileSync(filePath, content);
            files.push(filePath);
        }

        return files;
    }

    /**
     * Generate page object content
     */
    private generatePageObjectContent(state: ApplicationState, pageName: string): string {
        const elements = state.interactiveElements.slice(0, 30); // Limit elements

        const elementDeclarations = elements.map(el => {
            const name = this.generateElementName(el);
            const locator = this.getLocatorString(el);
            return `    @CSGetElement('${locator}')
    ${name}!: CSWebElement;`;
        }).join('\n\n');

        // Generate methods based on forms
        const methods: string[] = [];

        for (const form of state.forms) {
            const methodName = this.getFormMethodName(form);
            const params = form.fields.map(f => {
                const name = this.generateElementName(f);
                return `${name}: string`;
            }).join(', ');

            const body = form.fields.map(f => {
                const name = this.generateElementName(f);
                return `        await this.${name}.fill(${name});`;
            }).join('\n');

            const submitLine = form.submitButton
                ? `        await this.${this.generateElementName(form.submitButton)}.click();`
                : '';

            methods.push(`
    /**
     * ${methodName.replace(/([A-Z])/g, ' $1').trim()}
     */
    async ${methodName}(${params}): Promise<void> {
${body}
${submitLine}
    }`);
        }

        return `/**
 * ${pageName} - Auto-generated Page Object
 * Generated from exploration on ${new Date().toISOString()}
 */

import { CSBasePage } from '../../core/CSBasePage';
import { CSWebElement } from '../../core/CSWebElement';
import { CSGetElement, CSPage } from '../../decorators';

@CSPage('${pageName}')
export class ${pageName} extends CSBasePage {
${elementDeclarations}
${methods.join('\n')}
}

export default ${pageName};
`;
    }

    /**
     * Generate feature files
     */
    private async generateFeatureFiles(workflows: GeneratedWorkflow[], result: ExplorationResult): Promise<string[]> {
        const files: string[] = [];

        // Group workflows by type
        const workflowsByType = new Map<string, GeneratedWorkflow[]>();
        for (const workflow of workflows) {
            const existing = workflowsByType.get(workflow.type) || [];
            existing.push(workflow);
            workflowsByType.set(workflow.type, existing);
        }

        for (const [type, typeWorkflows] of workflowsByType) {
            const fileName = `${type}.feature`;
            const filePath = path.join(this.config.outputDir, 'features', fileName);

            const content = this.generateFeatureContent(type, typeWorkflows);
            fs.writeFileSync(filePath, content);
            files.push(filePath);
        }

        return files;
    }

    /**
     * Generate feature content
     */
    private generateFeatureContent(type: string, workflows: GeneratedWorkflow[]): string {
        const featureName = type.charAt(0).toUpperCase() + type.slice(1);
        const tags = `@${type} @generated @exploration`;

        const scenarios = workflows.map(workflow => {
            const scenarioSteps = workflow.steps.map(step => `        ${step.gherkinStep}`).join('\n');
            return `
    @${workflow.id}
    Scenario: ${workflow.name}
        # ${workflow.description}
${scenarioSteps}
`;
        }).join('\n');

        return `${tags}
Feature: ${featureName} Functionality
    As a user
    I want to perform ${type} operations
    So that I can manage the application effectively

    Background:
        Given I am on the application
${scenarios}
`;
    }

    /**
     * Generate step definitions
     */
    private async generateStepDefinitions(workflows: GeneratedWorkflow[], result: ExplorationResult): Promise<string[]> {
        const files: string[] = [];

        const fileName = 'generated.steps.ts';
        const filePath = path.join(this.config.outputDir, 'steps', fileName);

        const stepPatterns = new Set<string>();
        const stepImplementations: string[] = [];

        for (const workflow of workflows) {
            for (const step of workflow.steps) {
                // Extract pattern from Gherkin step
                const pattern = step.gherkinStep
                    .replace(/^(Given|When|Then|And)\s+/i, '')
                    .replace(/"\{[^}]+\}"/g, '"{string}"')
                    .replace(/"\w+"/g, '"{string}"');

                if (!stepPatterns.has(pattern)) {
                    stepPatterns.add(pattern);

                    const keyword = step.gherkinStep.match(/^(Given|When|Then|And)/i)?.[1] || 'When';
                    const implementation = this.generateStepImplementation(keyword, pattern, step);
                    stepImplementations.push(implementation);
                }
            }
        }

        const content = `/**
 * Generated Step Definitions
 * Auto-generated from exploration on ${new Date().toISOString()}
 */

import { Given, When, Then } from '@cucumber/cucumber';
import { expect } from '@playwright/test';
import { CSScenarioContext } from '../../bdd/CSScenarioContext';

${stepImplementations.join('\n\n')}
`;

        fs.writeFileSync(filePath, content);
        files.push(filePath);

        return files;
    }

    /**
     * Generate step implementation
     */
    private generateStepImplementation(keyword: string, pattern: string, step: WorkflowStep): string {
        const params = (pattern.match(/\{string\}/g) || []).map((_, i) => `param${i + 1}: string`).join(', ');

        let body = '';
        switch (step.action) {
            case 'click':
                body = `await this.page.locator('${step.target}').click();`;
                break;
            case 'fill':
                body = `await this.page.locator('${step.target}').fill(param1);`;
                break;
            case 'select':
                body = `await this.page.locator('${step.target}').selectOption(param1);`;
                break;
            case 'check':
                body = `await this.page.locator('${step.target}').check();`;
                break;
            case 'wait':
                body = `await this.page.waitForLoadState('networkidle');`;
                break;
            default:
                body = `// TODO: Implement ${step.action} action`;
        }

        if (step.assertion) {
            body += `\n    ${step.assertion.playwrightCode}`;
        }

        return `${keyword}('${pattern}', async function(this: CSScenarioContext${params ? ', ' + params : ''}) {
    ${body}
});`;
    }

    /**
     * Generate spec files
     */
    private async generateSpecFiles(workflows: GeneratedWorkflow[], result: ExplorationResult): Promise<string[]> {
        const files: string[] = [];

        for (const workflow of workflows) {
            const fileName = `${workflow.id}.spec.ts`;
            const filePath = path.join(this.config.outputDir, 'specs', fileName);

            const content = this.generateSpecContent(workflow);
            fs.writeFileSync(filePath, content);
            files.push(filePath);
        }

        return files;
    }

    /**
     * Generate spec content
     */
    private generateSpecContent(workflow: GeneratedWorkflow): string {
        const testSteps = workflow.steps.map(step => {
            let code = '';
            switch (step.action) {
                case 'click':
                    code = `await page.locator('${step.target}').click();`;
                    break;
                case 'fill':
                    const value = step.value?.startsWith('{')
                        ? `testData.${step.value.slice(1, -1)}`
                        : `'${step.value}'`;
                    code = `await page.locator('${step.target}').fill(${value});`;
                    break;
                case 'select':
                    code = `await page.locator('${step.target}').selectOption('${step.value}');`;
                    break;
                case 'check':
                    code = `await page.locator('${step.target}').check();`;
                    break;
                case 'wait':
                    code = `await page.waitForLoadState('networkidle');`;
                    break;
                case 'keyboard':
                    code = `await page.keyboard.press('${step.target}');`;
                    break;
                default:
                    code = `// TODO: Implement ${step.action}`;
            }

            if (step.assertion) {
                code += `\n        ${step.assertion.playwrightCode}`;
            }

            return `        // Step ${step.order}: ${step.gherkinStep}\n        ${code}`;
        }).join('\n\n');

        const testDataStr = Object.keys(workflow.testData).length > 0
            ? `const testData = ${JSON.stringify(workflow.testData, null, 4)};`
            : '';

        return `/**
 * ${workflow.name} - Auto-generated Test
 * ${workflow.description}
 * Generated from exploration on ${new Date().toISOString()}
 */

import { test, expect } from '@playwright/test';

test.describe('${workflow.name}', () => {
    ${testDataStr}

    test('${workflow.description}', async ({ page }) => {
${testSteps}
    });
});
`;
    }

    /**
     * Generate API tests
     */
    private async generateAPITests(apis: CapturedAPI[]): Promise<string[]> {
        const files: string[] = [];

        // Group APIs by resource type
        const apisByResource = new Map<string, CapturedAPI[]>();
        for (const api of apis) {
            const resource = api.resourceType || 'general';
            const existing = apisByResource.get(resource) || [];
            existing.push(api);
            apisByResource.set(resource, existing);
        }

        for (const [resource, resourceApis] of apisByResource) {
            const fileName = `${resource}-api.spec.ts`;
            const filePath = path.join(this.config.outputDir, 'api', fileName);

            const content = this.generateAPITestContent(resource, resourceApis);
            fs.writeFileSync(filePath, content);
            files.push(filePath);
        }

        return files;
    }

    /**
     * Generate API test content
     */
    private generateAPITestContent(resource: string, apis: CapturedAPI[]): string {
        const uniqueEndpoints = new Map<string, CapturedAPI>();
        for (const api of apis) {
            const key = `${api.method}-${api.urlPattern}`;
            if (!uniqueEndpoints.has(key)) {
                uniqueEndpoints.set(key, api);
            }
        }

        const tests = Array.from(uniqueEndpoints.values()).map(api => {
            const testName = `${api.method} ${api.urlPattern}`;
            const statusCheck = `expect(response.status()).toBe(${api.status});`;

            let bodyCheck = '';
            if (api.responseBody && typeof api.responseBody === 'object') {
                bodyCheck = `
        const body = await response.json();
        expect(body).toBeDefined();`;
            }

            return `
    test('${testName}', async ({ request }) => {
        const response = await request.${api.method.toLowerCase()}('${api.url}');
        ${statusCheck}${bodyCheck}
    });`;
        }).join('\n');

        return `/**
 * ${resource.charAt(0).toUpperCase() + resource.slice(1)} API Tests
 * Auto-generated from exploration on ${new Date().toISOString()}
 */

import { test, expect } from '@playwright/test';

test.describe('${resource.charAt(0).toUpperCase() + resource.slice(1)} API', () => {
${tests}
});
`;
    }

    // Helper methods

    private getLocatorString(element: InteractiveElement): string {
        const bestLocator = element.locators[0];
        return bestLocator?.value || element.tagName;
    }

    private generatePageName(state: ApplicationState): string {
        // Try to extract from URL
        try {
            const url = new URL(state.url);
            const pathParts = url.pathname.split('/').filter(Boolean);
            if (pathParts.length > 0) {
                const name = pathParts[pathParts.length - 1]
                    .replace(/[-_]/g, ' ')
                    .replace(/\b\w/g, c => c.toUpperCase())
                    .replace(/\s/g, '');
                return name + 'Page';
            }
        } catch { }

        // Fallback to page type
        return (state.pageType.charAt(0).toUpperCase() + state.pageType.slice(1)) + 'Page';
    }

    private generateElementName(element: InteractiveElement): string {
        const name = element.label || element.ariaLabel || element.placeholder || element.text || element.type;
        if (!name) return `element_${element.id.substring(0, 6)}`;

        return name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '')
            .substring(0, 30) + (element.type === 'button' ? 'Button' : element.type === 'input' ? 'Input' : '');
    }

    private getFormMethodName(form: FormDescriptor): string {
        switch (form.formType) {
            case 'login':
                return 'login';
            case 'register':
                return 'register';
            case 'search':
                return 'search';
            case 'contact':
                return 'submitContactForm';
            case 'checkout':
                return 'checkout';
            default:
                return 'submitForm';
        }
    }

    private generateSampleData(fieldType: string): string {
        const samples: Record<string, string> = {
            email: 'test@example.com',
            phone: '+1-555-123-4567',
            password: 'TestPass123!',
            username: 'testuser',
            name: 'John Doe',
            address: '123 Test Street',
            city: 'Test City',
            zipCode: '12345',
            date: new Date().toISOString().split('T')[0],
            number: '100',
            text: 'Sample text',
        };

        return samples[fieldType] || 'test value';
    }
}

export default TestSynthesizer;
