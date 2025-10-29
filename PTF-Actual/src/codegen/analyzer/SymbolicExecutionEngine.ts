/**
 * Symbolic Execution Engine for CS Codegen
 * Layer 2: Understands test BEHAVIOR without running it
 *
 * This engine symbolically executes the test to understand:
 * - What the test is TRYING to accomplish (intent)
 * - Business logic being tested
 * - Critical execution paths
 * - Potential failure points
 */

import {
    DeepCodeAnalysis,
    Action,
    TestIntent,
    IntentAnalysis,
    BusinessLogic,
    BusinessEntity,
    Workflow,
    Validation,
    ExecutionPath
} from '../types';

export class SymbolicExecutionEngine {
    /**
     * Execute test symbolically to understand behavior
     */
    public async executeSymbolically(analysis: DeepCodeAnalysis): Promise<IntentAnalysis> {
        const { actions, executionPaths } = analysis;

        // Analyze primary intent
        const primaryIntent = this.inferPrimaryIntent(actions);

        // Identify secondary intents
        const secondaryIntents = this.identifySecondaryIntents(actions);

        // Classify test type
        const testType = this.classifyTestType(actions, primaryIntent);

        // Extract business logic
        const businessLogic = this.extractBusinessLogic(actions);

        // Identify critical actions
        const criticalActions = this.identifyCriticalActions(actions);

        // Extract validations
        const validations = this.extractValidations(actions);

        // Calculate confidence
        const confidence = this.calculateConfidence(primaryIntent, businessLogic);

        return {
            primary: primaryIntent,
            secondary: secondaryIntents,
            testType,
            businessLogic,
            criticalActions,
            validations,
            confidence
        };
    }

    /**
     * Infer primary test intent from action sequence
     */
    private inferPrimaryIntent(actions: Action[]): TestIntent {
        // Pattern 1: Login Detection
        if (this.matchesLoginPattern(actions)) {
            return {
                type: 'authentication',
                subtype: 'login',
                confidence: 0.95,
                description: 'User authentication via login form',
                businessGoal: 'Verify user can authenticate with valid credentials',
                entities: ['User', 'Credentials', 'Session']
            };
        }

        // Pattern 2: CRUD Detection
        const crudType = this.detectCRUDPattern(actions);
        if (crudType) {
            return {
                type: 'crud',
                subtype: crudType,
                confidence: 0.90,
                description: `${crudType} operation on business entity`,
                businessGoal: `Verify ${crudType} functionality works correctly`,
                entities: this.extractEntitiesFromActions(actions)
            };
        }

        // Pattern 3: Form Submission
        if (this.matchesFormPattern(actions)) {
            return {
                type: 'form-interaction',
                subtype: 'submission',
                confidence: 0.88,
                description: 'Form filling and submission workflow',
                businessGoal: 'Verify form submission with valid data',
                entities: this.extractFormEntities(actions)
            };
        }

        // Pattern 4: Navigation Flow
        if (this.matchesNavigationPattern(actions)) {
            return {
                type: 'navigation',
                subtype: this.identifyNavigationType(actions),
                confidence: 0.85,
                description: 'Application navigation workflow',
                businessGoal: 'Verify navigation between pages works correctly',
                entities: this.extractNavigationEntities(actions)
            };
        }

        // Pattern 5: Verification/Assertion
        if (this.matchesVerificationPattern(actions)) {
            return {
                type: 'verification',
                subtype: 'state-check',
                confidence: 0.92,
                description: 'State verification and validation',
                businessGoal: 'Verify application state is correct',
                entities: []
            };
        }

        // Pattern 6: Search/Filter
        if (this.matchesSearchPattern(actions)) {
            return {
                type: 'crud',
                subtype: 'read',
                confidence: 0.87,
                description: 'Search and filter functionality',
                businessGoal: 'Verify search/filter returns correct results',
                entities: ['SearchResults', 'Filters']
            };
        }

        // Default: Generic
        return {
            type: 'generic',
            subtype: 'unknown',
            confidence: 0.5,
            description: 'Generic test scenario',
            businessGoal: 'Test application functionality',
            entities: []
        };
    }

    /**
     * Detect login pattern
     */
    private matchesLoginPattern(actions: Action[]): boolean {
        // Login pattern: goto → fill(username) → fill(password) → click(submit) → expect(dashboard/success)
        if (actions.length < 4) return false;

        const hasNavigation = actions.some(a => a.type === 'navigation');
        const fillActions = actions.filter(a => a.type === 'fill');
        const hasSubmit = actions.some(a => a.type === 'click' && this.isSubmitButton(a));
        const hasAssertion = actions.some(a => a.type === 'assertion');

        // Must have: navigation, 2+ fills (username + password), submit, assertion
        return hasNavigation && fillActions.length >= 2 && hasSubmit && hasAssertion;
    }

    /**
     * Check if action is a submit button click
     */
    private isSubmitButton(action: Action): boolean {
        const expression = action.expression.toLowerCase();
        return expression.includes('submit') ||
               expression.includes('login') ||
               expression.includes('sign in') ||
               expression.includes('type=submit');
    }

    /**
     * Detect CRUD pattern and return type
     */
    private detectCRUDPattern(actions: Action[]): 'create' | 'read' | 'update' | 'delete' | null {
        // CREATE: click(add/new) → fill multiple fields → click(save/submit)
        const hasAddButton = actions.some(a =>
            a.type === 'click' && this.isAddButton(a)
        );
        const hasFillActions = actions.filter(a => a.type === 'fill').length >= 2;
        const hasSaveButton = actions.some(a =>
            a.type === 'click' && this.isSaveButton(a)
        );

        if (hasAddButton && hasFillActions && hasSaveButton) {
            return 'create';
        }

        // UPDATE: click(edit) → fill fields → click(save/update)
        const hasEditButton = actions.some(a =>
            a.type === 'click' && this.isEditButton(a)
        );

        if (hasEditButton && hasFillActions && hasSaveButton) {
            return 'update';
        }

        // DELETE: click(delete) → click(confirm)
        const hasDeleteButton = actions.some(a =>
            a.type === 'click' && this.isDeleteButton(a)
        );
        const hasConfirm = actions.some(a =>
            a.type === 'click' && this.isConfirmButton(a)
        );

        if (hasDeleteButton && hasConfirm) {
            return 'delete';
        }

        // READ: Just viewing/verifying data
        const hasOnlyRead = !hasAddButton && !hasEditButton && !hasDeleteButton &&
                          actions.some(a => a.type === 'assertion');

        if (hasOnlyRead) {
            return 'read';
        }

        return null;
    }

    /**
     * Helper: Check if action is Add/New button
     */
    private isAddButton(action: Action): boolean {
        const expr = action.expression.toLowerCase();
        return expr.includes('add') || expr.includes('new') || expr.includes('create');
    }

    /**
     * Helper: Check if action is Save button
     */
    private isSaveButton(action: Action): boolean {
        const expr = action.expression.toLowerCase();
        return expr.includes('save') || expr.includes('submit');
    }

    /**
     * Helper: Check if action is Edit button
     */
    private isEditButton(action: Action): boolean {
        const expr = action.expression.toLowerCase();
        return expr.includes('edit') || expr.includes('modify') || expr.includes('update');
    }

    /**
     * Helper: Check if action is Delete button
     */
    private isDeleteButton(action: Action): boolean {
        const expr = action.expression.toLowerCase();
        return expr.includes('delete') || expr.includes('remove');
    }

    /**
     * Helper: Check if action is Confirm button
     */
    private isConfirmButton(action: Action): boolean {
        const expr = action.expression.toLowerCase();
        return expr.includes('confirm') || expr.includes('yes') || expr.includes('ok');
    }

    /**
     * Detect form pattern
     */
    private matchesFormPattern(actions: Action[]): boolean {
        // Form pattern: 3+ consecutive fill actions followed by submit
        const fillSequences = this.findConsecutiveFills(actions);
        return fillSequences.some(seq => seq.length >= 3);
    }

    /**
     * Find consecutive fill actions
     */
    private findConsecutiveFills(actions: Action[]): Action[][] {
        const sequences: Action[][] = [];
        let current: Action[] = [];

        for (const action of actions) {
            if (action.type === 'fill' || action.type === 'select') {
                current.push(action);
            } else {
                if (current.length > 0) {
                    sequences.push(current);
                    current = [];
                }
            }
        }

        if (current.length > 0) {
            sequences.push(current);
        }

        return sequences;
    }

    /**
     * Detect navigation pattern
     */
    private matchesNavigationPattern(actions: Action[]): boolean {
        const navigationActions = actions.filter(a =>
            a.type === 'navigation' || a.type === 'click'
        );
        return navigationActions.length >= 2;
    }

    /**
     * Identify navigation type
     */
    private identifyNavigationType(actions: Action[]): string {
        const hasMenu = actions.some(a =>
            a.expression.toLowerCase().includes('menu')
        );
        const hasBreadcrumb = actions.some(a =>
            a.expression.toLowerCase().includes('breadcrumb')
        );
        const hasTab = actions.some(a =>
            a.expression.toLowerCase().includes('tab')
        );

        if (hasMenu) return 'menu-navigation';
        if (hasBreadcrumb) return 'breadcrumb-navigation';
        if (hasTab) return 'tab-navigation';
        return 'link-navigation';
    }

    /**
     * Detect verification pattern
     */
    private matchesVerificationPattern(actions: Action[]): boolean {
        const assertionActions = actions.filter(a => a.type === 'assertion');
        return assertionActions.length >= 2 && actions.filter(a => a.type !== 'assertion').length < 3;
    }

    /**
     * Detect search pattern
     */
    private matchesSearchPattern(actions: Action[]): boolean {
        return actions.some(a =>
            a.type === 'fill' && (
                a.expression.toLowerCase().includes('search') ||
                a.expression.toLowerCase().includes('filter')
            )
        );
    }

    /**
     * Extract business entities from actions
     */
    private extractEntitiesFromActions(actions: Action[]): string[] {
        const entities = new Set<string>();

        for (const action of actions) {
            // Extract from button text
            if (action.type === 'click') {
                const matches = action.expression.match(/['"]([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)['\"]/g);
                if (matches) {
                    matches.forEach(m => {
                        const entity = m.replace(/['"]/g, '').replace(/\s+/g, '');
                        if (entity.length > 2) entities.add(entity);
                    });
                }
            }

            // Extract from placeholders
            if (action.target?.type === 'getByPlaceholder') {
                const placeholder = action.target.selector;
                entities.add(placeholder);
            }
        }

        return Array.from(entities);
    }

    /**
     * Extract form entities
     */
    private extractFormEntities(actions: Action[]): string[] {
        const fillActions = actions.filter(a => a.type === 'fill');
        return fillActions.map(a => a.target?.selector || 'Field').filter(Boolean);
    }

    /**
     * Extract navigation entities
     */
    private extractNavigationEntities(actions: Action[]): string[] {
        const navActions = actions.filter(a =>
            a.type === 'navigation' || a.type === 'click'
        );
        return navActions.map(a => {
            const match = a.expression.match(/['"]([^'"]+)['"]/);
            return match ? match[1] : 'Page';
        });
    }

    /**
     * Identify secondary intents
     */
    private identifySecondaryIntents(actions: Action[]): TestIntent[] {
        const intents: TestIntent[] = [];

        // Check for error handling
        if (actions.some(a => a.expression.toLowerCase().includes('error'))) {
            intents.push({
                type: 'verification',
                subtype: 'error-handling',
                confidence: 0.8,
                description: 'Error message validation'
            });
        }

        // Check for data validation
        if (actions.filter(a => a.type === 'assertion').length > 1) {
            intents.push({
                type: 'verification',
                subtype: 'data-validation',
                confidence: 0.85,
                description: 'Data correctness validation'
            });
        }

        return intents;
    }

    /**
     * Classify test type
     */
    private classifyTestType(
        actions: Action[],
        intent: TestIntent
    ): 'positive' | 'negative' | 'edge-case' | 'smoke' | 'integration' {
        // Smoke test: Basic happy path
        if (intent.type === 'authentication' || actions.length < 5) {
            return 'smoke';
        }

        // Negative test: Error scenarios
        if (actions.some(a => a.expression.toLowerCase().includes('error'))) {
            return 'negative';
        }

        // Integration: Multiple workflows
        if (intent.type === 'crud' && actions.length > 10) {
            return 'integration';
        }

        // Default: Positive
        return 'positive';
    }

    /**
     * Extract business logic from actions
     */
    private extractBusinessLogic(actions: Action[]): BusinessLogic {
        const entities = this.identifyBusinessEntities(actions);
        const workflows = this.identifyWorkflows(actions);
        const businessRules = this.inferBusinessRules(actions);
        const dataFlow = this.analyzeDataFlow(actions);

        return {
            entities,
            workflows,
            businessRules,
            dataFlow
        };
    }

    /**
     * Identify business entities
     */
    private identifyBusinessEntities(actions: Action[]): BusinessEntity[] {
        const entityMap = new Map<string, BusinessEntity>();

        for (const action of actions) {
            if (action.type === 'fill') {
                const fieldName = action.target?.selector || '';
                const entityName = this.inferEntityFromField(fieldName);

                if (!entityMap.has(entityName)) {
                    entityMap.set(entityName, {
                        name: entityName,
                        type: 'form',
                        properties: []
                    });
                }

                entityMap.get(entityName)!.properties.push(fieldName);
            }
        }

        return Array.from(entityMap.values());
    }

    /**
     * Infer entity name from field name
     */
    private inferEntityFromField(fieldName: string): string {
        // Extract root entity (e.g., "Username" -> "User", "ProductName" -> "Product")
        if (fieldName.toLowerCase().includes('user')) return 'User';
        if (fieldName.toLowerCase().includes('product')) return 'Product';
        if (fieldName.toLowerCase().includes('order')) return 'Order';
        if (fieldName.toLowerCase().includes('customer')) return 'Customer';
        return 'Entity';
    }

    /**
     * Identify workflows
     */
    private identifyWorkflows(actions: Action[]): Workflow[] {
        const workflow: Workflow = {
            name: 'Main Workflow',
            steps: actions.map((a, i) => `${i + 1}. ${this.describeAction(a)}`),
            type: this.determineWorkflowType(actions)
        };

        return [workflow];
    }

    /**
     * Describe action in human terms
     */
    private describeAction(action: Action): string {
        switch (action.type) {
            case 'navigation':
                return `Navigate to ${action.args[0] || 'page'}`;
            case 'click':
                return `Click on ${action.target?.selector || 'element'}`;
            case 'fill':
                return `Enter value in ${action.target?.selector || 'field'}`;
            case 'select':
                return `Select option from ${action.target?.selector || 'dropdown'}`;
            case 'assertion':
                return `Verify ${action.target?.selector || 'element'}`;
            default:
                return action.method;
        }
    }

    /**
     * Determine workflow type
     */
    private determineWorkflowType(actions: Action[]): 'linear' | 'branching' | 'looping' {
        // For now, assume linear (we would detect branches/loops from CFG)
        return 'linear';
    }

    /**
     * Infer business rules
     */
    private inferBusinessRules(actions: Action[]): string[] {
        const rules: string[] = [];

        // Required field validation
        const requiredFields = actions.filter(a => a.type === 'fill');
        if (requiredFields.length > 0) {
            rules.push(`User must provide ${requiredFields.length} required field(s)`);
        }

        // Authentication requirement
        if (this.matchesLoginPattern(actions)) {
            rules.push('User must be authenticated to access the system');
        }

        return rules;
    }

    /**
     * Analyze data flow
     */
    private analyzeDataFlow(actions: Action[]): string[] {
        return actions
            .filter(a => a.type === 'fill')
            .map(a => `${a.target?.selector || 'Field'} receives user input`);
    }

    /**
     * Identify critical actions
     */
    private identifyCriticalActions(actions: Action[]): Action[] {
        return actions.filter(a =>
            a.type === 'click' && this.isSubmitButton(a) ||
            a.type === 'assertion' ||
            a.type === 'navigation'
        );
    }

    /**
     * Extract validations
     */
    private extractValidations(actions: Action[]): Validation[] {
        return actions
            .filter(a => a.type === 'assertion')
            .map(a => ({
                type: 'assertion' as const,
                target: a.target?.selector || 'element',
                expected: a.args[0],
                lineNumber: a.lineNumber
            }));
    }

    /**
     * Calculate confidence score
     */
    private calculateConfidence(intent: TestIntent, businessLogic: BusinessLogic): number {
        let score = intent.confidence;

        // Boost confidence if we have business entities
        if (businessLogic.entities.length > 0) {
            score += 0.05;
        }

        // Boost if we have business rules
        if (businessLogic.businessRules.length > 0) {
            score += 0.03;
        }

        return Math.min(score, 1.0);
    }
}
