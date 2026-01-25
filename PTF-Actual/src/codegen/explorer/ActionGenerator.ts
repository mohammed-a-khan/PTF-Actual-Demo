/**
 * Action Generator
 * Generates candidate actions for automated exploration
 *
 * @module ActionGenerator
 */

import {
    InteractiveElement,
    CandidateAction,
    ActionType,
    FieldType,
    ApplicationState,
    FormDescriptor,
} from './types';

export interface TestDataConfig {
    locale?: string;
    seed?: number;
    customData?: Record<string, string>;
}

export class ActionGenerator {
    private testDataConfig: TestDataConfig;
    private usedValues: Map<string, Set<string>> = new Map();

    constructor(config: TestDataConfig = {}) {
        this.testDataConfig = {
            locale: 'en-US',
            ...config,
        };
    }

    /**
     * Generate all candidate actions for a state
     */
    generateActions(state: ApplicationState): CandidateAction[] {
        const actions: CandidateAction[] = [];

        // Generate form actions first (higher priority)
        for (const form of state.forms) {
            actions.push(...this.generateFormActions(form));
        }

        // Generate individual element actions
        for (const element of state.interactiveElements) {
            // Skip elements already handled by forms
            const isInForm = state.forms.some(f =>
                f.fields.some(field => field.id === element.id) ||
                f.submitButton?.id === element.id ||
                f.cancelButton?.id === element.id
            );

            if (!isInForm) {
                actions.push(...this.generateElementActions(element));
            }
        }

        // Prioritize and deduplicate
        return this.prioritizeActions(actions);
    }

    /**
     * Generate actions for a form (fill all fields and submit)
     */
    private generateFormActions(form: FormDescriptor): CandidateAction[] {
        const actions: CandidateAction[] = [];

        // Generate fill actions for each field
        for (const field of form.fields) {
            if (field.type === 'input' || field.type === 'textarea' || field.type === 'select') {
                const fillActions = this.generateFillActions(field);
                actions.push(...fillActions);
            } else if (field.type === 'checkbox' || field.type === 'radio') {
                actions.push(this.generateToggleAction(field));
            }
        }

        // Generate submit action
        if (form.submitButton) {
            actions.push({
                id: `submit-${form.id}`,
                element: form.submitButton,
                actionType: 'click',
                priority: 90,
                riskLevel: form.formType === 'login' ? 'safe' : 'moderate',
                expectedOutcome: `Submit ${form.formType} form`,
                expectedStateChange: true,
            });
        }

        // Generate cancel action (lower priority)
        if (form.cancelButton) {
            actions.push({
                id: `cancel-${form.id}`,
                element: form.cancelButton,
                actionType: 'click',
                priority: 30,
                riskLevel: 'safe',
                expectedOutcome: 'Cancel form and return',
                expectedStateChange: true,
            });
        }

        return actions;
    }

    /**
     * Generate actions for a single element
     */
    private generateElementActions(element: InteractiveElement): CandidateAction[] {
        const actions: CandidateAction[] = [];

        switch (element.type) {
            case 'button':
                actions.push(this.generateClickAction(element));
                break;

            case 'link':
                actions.push(this.generateNavigationAction(element));
                break;

            case 'input':
            case 'textarea':
                actions.push(...this.generateFillActions(element));
                break;

            case 'select':
                actions.push(...this.generateSelectActions(element));
                break;

            case 'checkbox':
            case 'radio':
                actions.push(this.generateToggleAction(element));
                break;

            case 'file':
                actions.push(this.generateFileUploadAction(element));
                break;

            case 'date':
            case 'time':
                actions.push(...this.generateDateTimeActions(element));
                break;

            case 'search':
                actions.push(...this.generateSearchActions(element));
                break;

            case 'tab':
            case 'menu':
                actions.push(this.generateClickAction(element));
                break;
        }

        return actions;
    }

    /**
     * Generate click action
     */
    private generateClickAction(element: InteractiveElement): CandidateAction {
        const riskLevel = this.assessRiskLevel(element);

        return {
            id: `click-${element.id}`,
            element,
            actionType: 'click',
            priority: this.calculatePriority(element, 'click'),
            riskLevel,
            expectedOutcome: this.describeExpectedOutcome(element, 'click'),
            expectedStateChange: riskLevel !== 'safe' || element.purpose === 'navigate',
        };
    }

    /**
     * Generate navigation action for links
     */
    private generateNavigationAction(element: InteractiveElement): CandidateAction {
        return {
            id: `navigate-${element.id}`,
            element,
            actionType: 'click',
            priority: this.calculatePriority(element, 'click'),
            riskLevel: 'safe',
            expectedOutcome: `Navigate to ${element.text || element.attributes['href'] || 'linked page'}`,
            expectedStateChange: true,
        };
    }

    /**
     * Generate fill actions for input fields
     */
    private generateFillActions(element: InteractiveElement): CandidateAction[] {
        const actions: CandidateAction[] = [];
        const fieldType = element.fieldType || 'text';

        // Valid data
        const validValue = this.generateTestData(fieldType, element);
        actions.push({
            id: `fill-valid-${element.id}`,
            element,
            actionType: 'fill',
            value: validValue,
            priority: this.calculatePriority(element, 'fill'),
            riskLevel: 'safe',
            expectedOutcome: `Fill ${element.label || fieldType} with valid data`,
            expectedStateChange: false,
        });

        // Empty value (boundary test)
        if (!element.isRequired) {
            actions.push({
                id: `fill-empty-${element.id}`,
                element,
                actionType: 'fill',
                value: '',
                priority: 20,
                riskLevel: 'safe',
                expectedOutcome: 'Test empty value handling',
                expectedStateChange: false,
            });
        }

        // Invalid data (for validation testing)
        const invalidValue = this.generateInvalidData(fieldType);
        if (invalidValue) {
            actions.push({
                id: `fill-invalid-${element.id}`,
                element,
                actionType: 'fill',
                value: invalidValue,
                priority: 15,
                riskLevel: 'safe',
                expectedOutcome: 'Test validation with invalid data',
                expectedStateChange: false,
            });
        }

        // Boundary values
        const boundaryValues = this.generateBoundaryData(element);
        for (let i = 0; i < boundaryValues.length; i++) {
            actions.push({
                id: `fill-boundary-${i}-${element.id}`,
                element,
                actionType: 'fill',
                value: boundaryValues[i],
                priority: 10,
                riskLevel: 'safe',
                expectedOutcome: 'Test boundary value handling',
                expectedStateChange: false,
            });
        }

        return actions;
    }

    /**
     * Generate select actions for dropdowns
     */
    private generateSelectActions(element: InteractiveElement): CandidateAction[] {
        const actions: CandidateAction[] = [];

        // We'll need to select options - for now generate placeholder
        // In real execution, we'd inspect the options
        actions.push({
            id: `select-first-${element.id}`,
            element,
            actionType: 'select',
            value: '__FIRST_OPTION__',
            priority: this.calculatePriority(element, 'select'),
            riskLevel: 'safe',
            expectedOutcome: 'Select first option',
            expectedStateChange: false,
        });

        actions.push({
            id: `select-last-${element.id}`,
            element,
            actionType: 'select',
            value: '__LAST_OPTION__',
            priority: 25,
            riskLevel: 'safe',
            expectedOutcome: 'Select last option',
            expectedStateChange: false,
        });

        return actions;
    }

    /**
     * Generate toggle action for checkboxes/radios
     */
    private generateToggleAction(element: InteractiveElement): CandidateAction {
        return {
            id: `toggle-${element.id}`,
            element,
            actionType: element.type === 'checkbox' ? 'check' : 'click',
            priority: this.calculatePriority(element, 'click'),
            riskLevel: 'safe',
            expectedOutcome: `Toggle ${element.label || element.type}`,
            expectedStateChange: false,
        };
    }

    /**
     * Generate file upload action
     */
    private generateFileUploadAction(element: InteractiveElement): CandidateAction {
        return {
            id: `upload-${element.id}`,
            element,
            actionType: 'upload',
            value: '__TEST_FILE__',
            priority: 30,
            riskLevel: 'safe',
            expectedOutcome: 'Upload test file',
            expectedStateChange: false,
        };
    }

    /**
     * Generate date/time actions
     */
    private generateDateTimeActions(element: InteractiveElement): CandidateAction[] {
        const actions: CandidateAction[] = [];
        const fieldType = element.fieldType || 'date';

        // Today/now
        const today = fieldType === 'date'
            ? new Date().toISOString().split('T')[0]
            : new Date().toTimeString().split(' ')[0].substring(0, 5);

        actions.push({
            id: `datetime-current-${element.id}`,
            element,
            actionType: 'fill',
            value: today,
            priority: this.calculatePriority(element, 'fill'),
            riskLevel: 'safe',
            expectedOutcome: `Set ${fieldType} to current`,
            expectedStateChange: false,
        });

        // Future date
        if (fieldType === 'date') {
            const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            actions.push({
                id: `datetime-future-${element.id}`,
                element,
                actionType: 'fill',
                value: future,
                priority: 25,
                riskLevel: 'safe',
                expectedOutcome: 'Set future date',
                expectedStateChange: false,
            });
        }

        return actions;
    }

    /**
     * Generate search actions
     */
    private generateSearchActions(element: InteractiveElement): CandidateAction[] {
        const actions: CandidateAction[] = [];

        // Common search terms
        const searchTerms = ['test', 'admin', 'user', 'sample'];

        actions.push({
            id: `search-${element.id}`,
            element,
            actionType: 'fill',
            value: searchTerms[0],
            priority: this.calculatePriority(element, 'fill'),
            riskLevel: 'safe',
            expectedOutcome: 'Perform search',
            expectedStateChange: true,
        });

        return actions;
    }

    /**
     * Generate realistic test data based on field type
     */
    generateTestData(fieldType: FieldType, element?: InteractiveElement): string {
        // Check for custom data first
        if (element?.label && this.testDataConfig.customData?.[element.label]) {
            return this.testDataConfig.customData[element.label];
        }

        const timestamp = Date.now();
        const random = Math.floor(Math.random() * 10000);

        const generators: Record<FieldType, () => string> = {
            email: () => `test.user.${timestamp}@example.com`,
            phone: () => `+1-555-${String(random).padStart(4, '0')}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`,
            date: () => new Date().toISOString().split('T')[0],
            datetime: () => new Date().toISOString().slice(0, 16),
            time: () => new Date().toTimeString().split(' ')[0].substring(0, 5),
            password: () => 'TestPass123!',
            username: () => `testuser_${timestamp}`,
            name: () => 'John Doe',
            firstName: () => 'John',
            lastName: () => 'Doe',
            fullName: () => 'John Doe',
            address: () => '123 Test Street',
            city: () => 'Test City',
            state: () => 'CA',
            country: () => 'United States',
            zipCode: () => '12345',
            postalCode: () => '12345',
            creditCard: () => '4111111111111111',
            cvv: () => '123',
            ssn: () => '123-45-6789',
            number: () => String(random),
            integer: () => String(Math.floor(random / 10)),
            decimal: () => (random / 100).toFixed(2),
            currency: () => (random / 100).toFixed(2),
            percentage: () => String(Math.min(random % 100, 100)),
            url: () => 'https://example.com/test',
            text: () => 'Sample test input',
            textarea: () => 'This is a sample text for testing purposes.\nIt contains multiple lines.',
            search: () => 'test search',
            file: () => 'test-file.txt',
            image: () => 'test-image.png',
            color: () => '#ff0000',
            range: () => '50',
            unknown: () => 'test value',
        };

        return generators[fieldType]?.() || 'test value';
    }

    /**
     * Generate invalid test data for validation testing
     */
    private generateInvalidData(fieldType: FieldType): string | null {
        const invalidData: Record<FieldType, string | null> = {
            email: 'invalid-email',
            phone: 'abc',
            date: 'not-a-date',
            datetime: 'invalid',
            time: 'invalid',
            password: 'a', // Too short
            username: '',
            name: '',
            firstName: '',
            lastName: '',
            fullName: '',
            address: '',
            city: '',
            state: '',
            country: '',
            zipCode: 'abcde',
            postalCode: 'abcde',
            creditCard: '1234',
            cvv: 'abc',
            ssn: 'invalid',
            number: 'abc',
            integer: '1.5',
            decimal: 'abc',
            currency: 'abc',
            percentage: '200',
            url: 'not-a-url',
            text: null,
            textarea: null,
            search: null,
            file: null,
            image: null,
            color: 'invalid',
            range: '999999',
            unknown: null,
        };

        return invalidData[fieldType];
    }

    /**
     * Generate boundary test data
     */
    private generateBoundaryData(element: InteractiveElement): string[] {
        const boundaries: string[] = [];

        // Min length boundary
        if (element.minLength && element.minLength > 0) {
            boundaries.push('a'.repeat(element.minLength - 1));
            boundaries.push('a'.repeat(element.minLength));
        }

        // Max length boundary
        if (element.maxLength && element.maxLength > 0) {
            boundaries.push('a'.repeat(element.maxLength));
            boundaries.push('a'.repeat(element.maxLength + 1));
        }

        // Numeric boundaries
        if (element.fieldType === 'number' || element.fieldType === 'integer') {
            if (element.min !== undefined) {
                boundaries.push(String(element.min - 1));
                boundaries.push(String(element.min));
            }
            if (element.max !== undefined) {
                boundaries.push(String(element.max));
                boundaries.push(String(element.max + 1));
            }
        }

        // Special characters
        boundaries.push('<script>alert("xss")</script>');
        boundaries.push("'; DROP TABLE users; --");

        return boundaries.slice(0, 3); // Limit to 3 boundaries
    }

    /**
     * Calculate action priority
     */
    private calculatePriority(element: InteractiveElement, actionType: ActionType): number {
        let priority = 50;

        // Purpose-based priority
        const highPriorityPurposes = ['submit', 'login', 'search', 'add', 'save'];
        const mediumPriorityPurposes = ['navigate', 'edit', 'delete', 'filter'];
        const lowPriorityPurposes = ['cancel', 'close', 'reset'];

        if (highPriorityPurposes.includes(element.purpose)) {
            priority += 30;
        } else if (mediumPriorityPurposes.includes(element.purpose)) {
            priority += 15;
        } else if (lowPriorityPurposes.includes(element.purpose)) {
            priority -= 20;
        }

        // Required fields are higher priority
        if (element.isRequired) {
            priority += 10;
        }

        // Visible elements are higher priority
        if (element.isVisible) {
            priority += 5;
        }

        // Test ID presence indicates important element
        if (element.locators.some(l => l.type === 'testid')) {
            priority += 10;
        }

        return Math.min(100, Math.max(0, priority));
    }

    /**
     * Assess risk level of action
     */
    private assessRiskLevel(element: InteractiveElement): CandidateAction['riskLevel'] {
        // Destructive purposes
        if (element.purpose === 'delete') {
            return 'destructive';
        }

        // Potentially modifying purposes
        if (['submit', 'save', 'edit', 'add'].includes(element.purpose)) {
            return 'moderate';
        }

        // Text contains destructive words
        const dangerWords = ['delete', 'remove', 'destroy', 'clear', 'reset'];
        const text = (element.text || '').toLowerCase();
        if (dangerWords.some(word => text.includes(word))) {
            return 'destructive';
        }

        return 'safe';
    }

    /**
     * Describe expected outcome
     */
    private describeExpectedOutcome(element: InteractiveElement, action: ActionType): string {
        const label = element.label || element.text || element.ariaLabel || element.type;

        switch (element.purpose) {
            case 'submit':
                return 'Submit form and navigate to result';
            case 'login':
                return 'Authenticate and navigate to dashboard';
            case 'logout':
                return 'Sign out and navigate to login page';
            case 'search':
                return 'Filter/search results';
            case 'add':
                return 'Open create form or add item';
            case 'edit':
                return 'Open edit form';
            case 'delete':
                return 'Show delete confirmation';
            case 'navigate':
                return `Navigate to ${label}`;
            case 'toggle':
                return `Toggle ${label}`;
            case 'filter':
                return 'Filter displayed data';
            case 'sort':
                return 'Sort data';
            default:
                return `${action} ${label}`;
        }
    }

    /**
     * Prioritize and deduplicate actions
     */
    private prioritizeActions(actions: CandidateAction[]): CandidateAction[] {
        // Sort by priority (descending)
        actions.sort((a, b) => b.priority - a.priority);

        // Remove duplicates (same element and action type)
        const seen = new Set<string>();
        const unique: CandidateAction[] = [];

        for (const action of actions) {
            const key = `${action.element.id}-${action.actionType}-${action.value || ''}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(action);
            }
        }

        return unique;
    }
}

export default ActionGenerator;
