/**
 * INTELLIGENT NAMING SYSTEM
 *
 * Generates semantic, meaningful names for:
 * 1. Elements - based on purpose and context
 * 2. Methods - based on workflow and action groups
 * 3. Gherkin steps - business-readable descriptions
 * 4. Page objects - based on module and function
 */

import { Action } from '../types';
import { ElementContext } from './ContextExtractor';
import { Pattern } from './PatternRecognitionEngine';
import { CSReporter } from '../../reporter/CSReporter';

export class IntelligentNamingSystem {

    /**
     * Generate semantic element name
     */
    public generateElementName(
        action: Action,
        context: ElementContext
    ): string {
        const { fieldLabel, elementType, purpose, pageModule } = context;

        // Special handling for common elements
        if (elementType === 'textbox') {
            if (purpose.includes('username')) return 'usernameField';
            if (purpose.includes('password')) return 'passwordField';
            if (purpose.includes('email')) return 'emailField';
            if (purpose.includes('search')) return 'searchInput';

            if (fieldLabel) {
                return this.toCamelCase(this.sanitize(fieldLabel)) + 'Field';
            }

            return 'inputField';
        }

        if (elementType === 'button') {
            const buttonName = action.target?.options?.name || '';

            if (buttonName.toLowerCase().includes('search')) return 'searchButton';
            if (buttonName.toLowerCase().includes('save')) return 'saveButton';
            if (buttonName.toLowerCase().includes('delete')) return 'deleteButton';
            if (buttonName.toLowerCase().includes('cancel')) return 'cancelButton';
            if (buttonName.toLowerCase().includes('login')) return 'loginButton';
            if (buttonName.toLowerCase().includes('submit')) return 'submitButton';

            if (buttonName && buttonName.trim()) {
                return this.toCamelCase(this.sanitize(buttonName)) + 'Button';
            }

            // Empty button name - use purpose
            if (purpose.includes('delete')) return 'deleteButton';
            if (purpose.includes('confirm')) return 'confirmButton';

            return 'actionButton';
        }

        if (elementType === 'link') {
            const linkName = action.target?.options?.name || '';
            if (linkName) {
                return this.toCamelCase(this.sanitize(linkName)) + 'Link';
            }
            return 'navigationLink';
        }

        if (elementType === 'dropdown') {
            if (purpose.includes('status')) return 'statusFilterDropdown';
            if (purpose.includes('role')) return 'roleDropdown';
            if (purpose.includes('type')) return 'typeDropdown';
            if (purpose.includes('employment')) return 'employmentStatusDropdown';

            return 'filterDropdown';
        }

        if (elementType === 'checkbox') {
            if (purpose.includes('select')) return 'selectionCheckbox';
            if (purpose.includes('remember')) return 'rememberMeCheckbox';
            return 'checkbox';
        }

        if (elementType === 'table') {
            return 'resultsTable';
        }

        if (elementType === 'toast') {
            return 'notificationToast';
        }

        if (elementType === 'heading') {
            return 'pageHeading';
        }

        if (elementType === 'text') {
            const text = action.target?.selector || '';
            if (text.includes('confirm') || text.includes('delete') || text.includes('will be')) {
                return 'confirmationMessage';
            }
            return this.toCamelCase(this.sanitize(text.substring(0, 30))) + 'Text';
        }

        if (elementType === 'row') {
            return 'dataRow';
        }

        return 'element';
    }

    /**
     * Generate method name from pattern or action group
     */
    public generateMethodName(
        pattern: Pattern,
        context: ElementContext
    ): string {
        switch (pattern.type) {
            case 'dropdown':
                const field = pattern.data.fieldContext;
                return `selectFrom${this.toPascalCase(field)}Dropdown`;

            case 'modal':
                if (pattern.data.action === 'confirm') {
                    return 'confirmAction';
                }
                return 'cancelAction';

            case 'login':
                return 'loginAs';

            case 'search':
                if (pattern.data.searchFields.length > 0) {
                    const firstField = pattern.data.searchFields[0].field;
                    return `searchBy${this.toPascalCase(firstField)}`;
                }
                return 'performSearch';

            case 'navigation':
                const module = pattern.data.targetModule;
                return `navigateTo${this.toPascalCase(module)}`;

            default:
                return 'performAction';
        }
    }

    /**
     * Generate Gherkin step text from pattern
     */
    public generateGherkinStepText(
        pattern: Pattern,
        context: ElementContext
    ): string {
        switch (pattern.type) {
            case 'dropdown':
                const option = pattern.data.optionText;
                const field = pattern.data.fieldContext;
                return `When I filter by "${option}" ${field.toLowerCase()}`;

            case 'modal':
                if (pattern.data.action === 'confirm') {
                    return `When I confirm the action`;
                }
                if (pattern.data.action === 'cancel') {
                    return `When I cancel the action`;
                }
                return `When I close the dialog`;

            case 'login':
                return `Given I am logged in as "{username}"`;

            case 'search':
                if (pattern.data.searchFields.length > 0) {
                    const field = pattern.data.searchFields[0].field;
                    return `When I search by ${field.toLowerCase()}`;
                }
                return `When I perform the search`;

            case 'navigation':
                const module = pattern.data.targetModule;
                return `Given I navigate to the ${module} page`;

            default:
                return `When I perform an action`;
        }
    }

    /**
     * Generate page object class name from module
     */
    public generatePageObjectName(module: string, subContext?: string): string {
        const clean = this.toPascalCase(module);

        // Add context-specific suffix
        switch (module.toLowerCase()) {
            case 'admin':
                return 'AdminUsersPage';
            case 'pim':
                return 'PIMEmployeesPage';
            case 'leave':
                return 'LeaveManagementPage';
            case 'time':
                return 'TimeManagementPage';
            case 'login':
                return 'LoginPage';
            case 'dashboard':
                return 'DashboardPage';
            case 'directory':
                return 'EmployeeDirectoryPage';
            default:
                return `${clean}Page`;
        }
    }

    /**
     * Generate step definition class name from module
     */
    public generateStepDefinitionName(module: string): string {
        const clean = this.toPascalCase(module);

        switch (module.toLowerCase()) {
            case 'admin':
                return 'AdminUsersSteps';
            case 'pim':
                return 'PIMEmployeesSteps';
            case 'leave':
                return 'LeaveManagementSteps';
            case 'time':
                return 'TimeManagementSteps';
            case 'login':
            case 'authentication':
                return 'AuthenticationSteps';
            case 'navigation':
                return 'NavigationSteps';
            default:
                return `${clean}Steps`;
        }
    }

    /**
     * Generate feature name from test intent
     */
    public generateFeatureName(modules: string[], intent: string): string {
        if (modules.length === 1) {
            const module = modules[0];
            switch (module.toLowerCase()) {
                case 'login':
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

        // Multiple modules
        if (intent.includes('search')) {
            return 'Multi-Module Search Operations';
        }
        if (intent.includes('navigation')) {
            return 'Cross-Module Navigation';
        }

        return 'Multi-Module Operations';
    }

    /**
     * Generate scenario name from pattern group
     */
    public generateScenarioName(patterns: Pattern[], module: string): string {
        if (patterns.length === 0) return 'Perform operation';

        const mainPattern = patterns[0];

        switch (mainPattern.type) {
            case 'search':
                return `Search for records in ${module}`;

            case 'dropdown':
                const option = mainPattern.data.optionText;
                return `Filter by ${option} status`;

            case 'modal':
                if (mainPattern.data.action === 'cancel') {
                    return `Cancel deletion in ${module}`;
                }
                return `Confirm operation in ${module}`;

            case 'navigation':
                return `Navigate between modules`;

            case 'login':
                return `User logs into the system`;

            default:
                return `Perform operation in ${module}`;
        }
    }

    /**
     * Convert to camelCase
     */
    private toCamelCase(str: string): string {
        return str
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .split(/\s+/)
            .map((word, index) =>
                index === 0
                    ? word.toLowerCase()
                    : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
            )
            .join('');
    }

    /**
     * Convert to PascalCase
     */
    private toPascalCase(str: string): string {
        return str
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .split(/\s+/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('');
    }

    /**
     * Convert to kebab-case
     */
    public toKebabCase(str: string): string {
        return str
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .replace(/[\s_]+/g, '-')
            .toLowerCase();
    }

    /**
     * Sanitize string for identifier
     */
    private sanitize(str: string): string {
        return str
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .trim();
    }

    /**
     * Generate method parameter name
     */
    public generateParameterName(fieldName: string): string {
        return this.toCamelCase(fieldName);
    }

    /**
     * Generate variable name for page object
     */
    public generatePageVariableName(className: string): string {
        const baseName = className.replace('Page', '').replace('Component', '');
        return this.toCamelCase(baseName + 'Page');
    }
}
