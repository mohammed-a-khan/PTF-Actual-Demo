/**
 * CONTEXT EXTRACTOR
 *
 * Extracts contextual information from actions and patterns:
 * 1. Field labels and purposes
 * 2. Page modules (Admin, PIM, etc.)
 * 3. Element purposes from usage
 * 4. Business terminology
 */

import { Action } from '../types';
import { Pattern } from './PatternRecognitionEngine';
import { CSReporter } from '../../reporter/CSReporter';

export interface ElementContext {
    fieldLabel?: string;
    elementType: 'textbox' | 'dropdown' | 'button' | 'link' | 'checkbox' | 'table' | 'toast' | 'heading' | 'text' | 'row';
    pageModule: string;
    purpose: string;
    actionType: 'fill' | 'click' | 'select' | 'verify';
    businessTerm?: string;
}

export class ContextExtractor {

    /**
     * Extract context for an element from its action
     */
    public extractElementContext(
        action: Action,
        patterns: Pattern[],
        allActions: Action[]
    ): ElementContext {
        const elementType = this.detectElementType(action);
        const pageModule = this.extractPageModule(action, allActions);
        const purpose = this.extractElementPurpose(action, patterns, elementType);
        const fieldLabel = this.extractFieldLabel(action);
        const actionType = this.mapActionType(action.type);
        const businessTerm = this.extractBusinessTerminology(action, purpose);

        return {
            fieldLabel,
            elementType,
            pageModule,
            purpose,
            actionType,
            businessTerm
        };
    }

    /**
     * Detect element type from action
     */
    private detectElementType(action: Action): ElementContext['elementType'] {
        if (!action.target) return 'text';

        const role = action.target.type === 'getByRole' ? action.target.selector : '';
        const selector = action.target.selector?.toLowerCase() || '';

        // Role-based detection
        if (role === 'textbox' || role === 'input') return 'textbox';
        if (role === 'button') return 'button';
        if (role === 'link') return 'link';
        if (role === 'checkbox') return 'checkbox';
        if (role === 'table') return 'table';
        if (role === 'heading') return 'heading';
        if (role === 'listbox') return 'dropdown';
        if (role === 'row') return 'row';

        // Selector-based detection
        if (selector.includes('select') || selector.includes('dropdown')) return 'dropdown';
        if (selector.includes('toast') || selector.includes('notification')) return 'toast';
        if (selector.includes('checkbox')) return 'checkbox';
        if (selector.includes('button')) return 'button';
        if (selector.includes('table')) return 'table';

        // Type-based detection
        if (action.target.type === 'getByText') return 'text';

        return 'text';
    }

    /**
     * Extract page module from URL or navigation context
     */
    private extractPageModule(action: Action, allActions: Action[]): string {
        // Check URL in action (for goto actions)
        if (action.type === 'navigation') {
            const url = action.expression;
            return this.extractModuleFromUrl(url);
        }

        // Look for most recent navigation link click
        const actionIndex = allActions.indexOf(action);
        for (let i = actionIndex - 1; i >= 0; i--) {
            const prevAction = allActions[i];
            if (prevAction.type === 'click' &&
                prevAction.target?.type === 'getByRole' &&
                prevAction.target.selector === 'link') {

                const linkName = prevAction.target.options?.name || '';
                const modules = ['Admin', 'PIM', 'Leave', 'Time', 'Recruitment',
                               'Performance', 'Dashboard', 'Directory'];

                for (const module of modules) {
                    if (linkName.includes(module)) {
                        return module;
                    }
                }
            }

            // Stop if we hit another navigation
            if (prevAction.type === 'navigation') break;
        }

        // Check if this is login page
        const selector = action.target?.selector?.toLowerCase() || '';
        const name = action.target?.options?.name?.toLowerCase() || '';
        if (selector.includes('username') || selector.includes('password') ||
            name.includes('login')) {
            return 'Login';
        }

        return 'Unknown';
    }

    /**
     * Extract module name from URL
     */
    private extractModuleFromUrl(url: string): string {
        if (url.includes('/admin')) return 'Admin';
        if (url.includes('/pim')) return 'PIM';
        if (url.includes('/leave')) return 'Leave';
        if (url.includes('/time')) return 'Time';
        if (url.includes('/recruitment')) return 'Recruitment';
        if (url.includes('/performance')) return 'Performance';
        if (url.includes('/dashboard')) return 'Dashboard';
        if (url.includes('/directory')) return 'Directory';
        if (url.includes('/login') || url.includes('/auth')) return 'Login';

        return 'Unknown';
    }

    /**
     * Extract element purpose from usage and patterns
     */
    private extractElementPurpose(
        action: Action,
        patterns: Pattern[],
        elementType: ElementContext['elementType']
    ): string {
        // Check if part of a pattern
        const pattern = patterns.find(p =>
            p.actions.some(a => a === action)
        );

        if (pattern) {
            switch (pattern.type) {
                case 'dropdown':
                    return 'filter by criteria';
                case 'modal':
                    if (pattern.data.action === 'confirm') {
                        return 'confirm action';
                    }
                    return 'cancel action';
                case 'login':
                    if (action.target?.selector?.toLowerCase().includes('username')) {
                        return 'authenticate with username';
                    }
                    if (action.target?.selector?.toLowerCase().includes('password')) {
                        return 'authenticate with password';
                    }
                    return 'submit login credentials';
                case 'search':
                    if (action.type === 'fill') {
                        return 'enter search criteria';
                    }
                    if (action.target?.options?.name?.toLowerCase().includes('search')) {
                        return 'execute search';
                    }
                    return 'filter results';
                case 'navigation':
                    return `navigate to ${pattern.data.targetModule}`;
            }
        }

        // Infer purpose from element type and action
        switch (elementType) {
            case 'textbox':
                return action.target?.options?.name ?
                    `enter ${action.target.options.name.toLowerCase()}` :
                    'enter value';

            case 'button':
                const buttonName = action.target?.options?.name?.toLowerCase() || '';
                if (buttonName.includes('search')) return 'execute search';
                if (buttonName.includes('save')) return 'save changes';
                if (buttonName.includes('delete')) return 'delete record';
                if (buttonName.includes('cancel')) return 'cancel operation';
                if (buttonName.includes('submit')) return 'submit form';
                if (buttonName.includes('login')) return 'submit login';
                return 'perform action';

            case 'link':
                const linkName = action.target?.options?.name || '';
                return `navigate to ${linkName}`;

            case 'dropdown':
                return 'select option';

            case 'checkbox':
                return 'select item';

            case 'table':
                return 'view results';

            case 'toast':
                return 'show notification';

            case 'heading':
                return 'verify page loaded';

            default:
                return 'interact with element';
        }
    }

    /**
     * Extract field label from element
     */
    private extractFieldLabel(action: Action): string | undefined {
        if (!action.target) return undefined;

        // Check role name
        if (action.target.options?.name) {
            return action.target.options.name;
        }

        // Check selector
        const selector = action.target.selector || '';

        // Extract from placeholder
        if (selector.includes('placeholder')) {
            const match = selector.match(/placeholder[=\s]*["']([^"']+)["']/);
            if (match) return match[1];
        }

        // Extract from data attributes
        if (selector.includes('data-label')) {
            const match = selector.match(/data-label[=\s]*["']([^"']+)["']/);
            if (match) return match[1];
        }

        return undefined;
    }

    /**
     * Map action type to semantic type
     */
    private mapActionType(actionType: string): ElementContext['actionType'] {
        switch (actionType) {
            case 'fill':
                return 'fill';
            case 'click':
                return 'click';
            case 'assertion':
                return 'verify';
            default:
                return 'click';
        }
    }

    /**
     * Extract business terminology from context
     */
    private extractBusinessTerminology(action: Action, purpose: string): string | undefined {
        // Extract from purpose
        if (purpose.includes('filter by')) {
            return 'Filter';
        }
        if (purpose.includes('search')) {
            return 'Search';
        }
        if (purpose.includes('delete')) {
            return 'Delete';
        }
        if (purpose.includes('save')) {
            return 'Save';
        }
        if (purpose.includes('navigate')) {
            return 'Navigation';
        }
        if (purpose.includes('authenticate')) {
            return 'Authentication';
        }

        // Extract from element name
        const name = action.target?.options?.name?.toLowerCase() || '';
        if (name.includes('user')) return 'User Management';
        if (name.includes('employee')) return 'Employee Management';
        if (name.includes('admin')) return 'Administration';

        return undefined;
    }

    /**
     * Extract module-specific terminology
     */
    public extractModuleTerminology(module: string): string {
        switch (module) {
            case 'Admin':
                return 'User Administration';
            case 'PIM':
                return 'Employee Information';
            case 'Leave':
                return 'Leave Management';
            case 'Time':
                return 'Time Tracking';
            case 'Recruitment':
                return 'Recruitment';
            case 'Performance':
                return 'Performance Management';
            case 'Dashboard':
                return 'Dashboard';
            case 'Directory':
                return 'Employee Directory';
            default:
                return module;
        }
    }

    /**
     * Generate page class name from module
     */
    public generatePageClassName(module: string, context?: string): string {
        const baseName = module.replace(/\s+/g, '');

        // Add context-specific suffix
        if (context) {
            if (context.includes('search') || context.includes('list')) {
                return `${baseName}Page`;
            }
        }

        // Module-specific naming
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
            default:
                return `${baseName}Page`;
        }
    }
}
