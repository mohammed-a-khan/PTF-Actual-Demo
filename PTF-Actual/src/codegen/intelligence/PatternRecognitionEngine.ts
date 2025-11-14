/**
 * PATTERN RECOGNITION ENGINE
 *
 * Detects common UI patterns in recorded actions:
 * 1. Dropdown selection (click icon → select option)
 * 2. Modal interactions (open → interact → close)
 * 3. Login flow (username → password → submit)
 * 4. Search flow (fill criteria → click search → verify results)
 * 5. Navigation (click link → verify page load)
 */

import { Action } from '../types';
import { CSReporter } from '../../reporter/CSReporter';

export interface Pattern {
    type: 'dropdown' | 'modal' | 'login' | 'search' | 'navigation' | 'form-fill' | 'deletion';
    actions: Action[];
    startIndex: number;
    endIndex: number;
    confidence: number;
    data: Record<string, any>;
}

export interface DropdownPattern extends Pattern {
    type: 'dropdown';
    data: {
        triggerSelector: string;
        optionText: string;
        fieldContext: string;
    };
}

export interface ModalPattern extends Pattern {
    type: 'modal';
    data: {
        modalText: string;
        action: 'confirm' | 'cancel' | 'close';
        triggerAction: string;
    };
}

export interface LoginPattern extends Pattern {
    type: 'login';
    data: {
        username: string;
        password: string;
        hasRememberMe: boolean;
    };
}

export interface SearchPattern extends Pattern {
    type: 'search';
    data: {
        searchFields: Array<{field: string; value: string}>;
        hasFilters: boolean;
        hasResults: boolean;
    };
}

export interface NavigationPattern extends Pattern {
    type: 'navigation';
    data: {
        linkText: string;
        targetModule: string;
        verified: boolean;
    };
}

export class PatternRecognitionEngine {

    /**
     * Detect all patterns in actions
     */
    public detectPatterns(actions: Action[]): Pattern[] {
        const patterns: Pattern[] = [];

        CSReporter.info('🔍 Detecting UI patterns...');

        // Detect patterns sequentially
        let i = 0;
        while (i < actions.length) {
            // Try each pattern detector
            const dropdown = this.detectDropdownPattern(actions, i);
            if (dropdown) {
                patterns.push(dropdown);
                i = dropdown.endIndex + 1;
                continue;
            }

            const modal = this.detectModalPattern(actions, i);
            if (modal) {
                patterns.push(modal);
                i = modal.endIndex + 1;
                continue;
            }

            const login = this.detectLoginPattern(actions, i);
            if (login) {
                patterns.push(login);
                i = login.endIndex + 1;
                continue;
            }

            const search = this.detectSearchPattern(actions, i);
            if (search) {
                patterns.push(search);
                i = search.endIndex + 1;
                continue;
            }

            const navigation = this.detectNavigationPattern(actions, i);
            if (navigation) {
                patterns.push(navigation);
                i = navigation.endIndex + 1;
                continue;
            }

            i++;
        }

        CSReporter.info(`✅ Detected ${patterns.length} patterns:`);
        patterns.forEach(p => CSReporter.info(`   - ${p.type} (confidence: ${(p.confidence * 100).toFixed(0)}%)`));

        return patterns;
    }

    /**
     * Detect dropdown selection pattern
     * Pattern: click(.oxd-select .oxd-icon) → click(getByText('option'))
     */
    private detectDropdownPattern(actions: Action[], startIndex: number): DropdownPattern | null {
        if (startIndex >= actions.length - 1) return null;

        const action1 = actions[startIndex];
        const action2 = actions[startIndex + 1];

        // Check if first action clicks a dropdown trigger
        if (action1.type !== 'click') return null;

        const selector1 = action1.target?.selector || '';
        const isDropdownTrigger =
            selector1.includes('.oxd-select') ||
            selector1.includes('.oxd-icon') ||
            (selector1.includes('select') && selector1.includes('icon')) ||
            action1.target?.type === 'getByRole' && action1.target.selector === 'listbox';

        if (!isDropdownTrigger) return null;

        // Check if second action selects an option
        if (action2.type !== 'click') return null;
        if (action2.target?.type !== 'getByText' &&
            action2.target?.type !== 'getByRole') return null;

        const optionText = action2.target.options?.name || action2.target.selector || '';

        // Extract field context (look for nearby labels or element position)
        const fieldContext = this.extractDropdownContext(action1, optionText);

        return {
            type: 'dropdown',
            actions: [action1, action2],
            startIndex,
            endIndex: startIndex + 1,
            confidence: 0.95,
            data: {
                triggerSelector: selector1,
                optionText,
                fieldContext
            }
        };
    }

    /**
     * Detect modal interaction pattern
     * Pattern: click(trigger) → expect(modal text) → click(button)
     */
    private detectModalPattern(actions: Action[], startIndex: number): ModalPattern | null {
        if (startIndex >= actions.length - 2) return null;

        let i = startIndex;
        const patternActions: Action[] = [];
        let modalText = '';
        let actionType: 'confirm' | 'cancel' | 'close' = 'close';

        // Look for assertion with modal/dialog text
        while (i < actions.length && i < startIndex + 5) {
            const action = actions[i];

            if (action.type === 'assertion') {
                // Check if this is a modal/dialog assertion
                const expr = action.expression;
                if (expr.includes('getByText') &&
                    (expr.includes('will be') || expr.includes('confirm') ||
                     expr.includes('sure') || expr.includes('delete'))) {

                    const textMatch = expr.match(/getByText\(['"]([^'"]+)['"]/);
                    if (textMatch) {
                        modalText = textMatch[1];
                        patternActions.push(action);
                    }
                }
            }

            if (action.type === 'click' && action.target?.type === 'getByRole') {
                const buttonName = action.target.options?.name || '';
                if (buttonName.toLowerCase().includes('cancel') ||
                    buttonName.toLowerCase().includes('no')) {
                    actionType = 'cancel';
                    patternActions.push(action);
                    break;
                } else if (buttonName.toLowerCase().includes('confirm') ||
                          buttonName.toLowerCase().includes('yes') ||
                          buttonName.toLowerCase().includes('ok')) {
                    actionType = 'confirm';
                    patternActions.push(action);
                    break;
                }
            }

            i++;
        }

        if (patternActions.length < 2 || !modalText) return null;

        // Find trigger action (usually 1-2 actions before modal appears)
        let triggerAction = 'unknown';
        if (startIndex > 0) {
            const prevAction = actions[startIndex - 1];
            if (prevAction.type === 'click') {
                triggerAction = prevAction.target?.options?.name || 'button';
            }
        }

        return {
            type: 'modal',
            actions: patternActions,
            startIndex,
            endIndex: i,
            confidence: 0.9,
            data: {
                modalText,
                action: actionType,
                triggerAction
            }
        };
    }

    /**
     * Detect login pattern
     * Pattern: fill(username) → fill(password) → click(login)
     */
    private detectLoginPattern(actions: Action[], startIndex: number): LoginPattern | null {
        if (startIndex >= actions.length - 2) return null;

        const patternActions: Action[] = [];
        let username = '';
        let password = '';
        let hasRememberMe = false;

        // Look for username field
        for (let i = startIndex; i < Math.min(startIndex + 6, actions.length); i++) {
            const action = actions[i];

            if (action.type === 'fill') {
                const selector = action.target?.selector?.toLowerCase() || '';
                const name = action.target?.options?.name?.toLowerCase() || '';

                if (selector.includes('username') || name.includes('username')) {
                    username = action.args[0] as string || '';
                    patternActions.push(action);
                } else if (selector.includes('password') || name.includes('password')) {
                    password = action.args[0] as string || '';
                    patternActions.push(action);
                }
            }

            if (action.type === 'click') {
                const buttonName = action.target?.options?.name?.toLowerCase() || '';
                if (buttonName.includes('login') || buttonName.includes('sign in')) {
                    patternActions.push(action);
                    break;
                }
            }
        }

        // Validate we have login pattern
        if (!username || !password || patternActions.length < 3) return null;

        return {
            type: 'login',
            actions: patternActions,
            startIndex,
            endIndex: startIndex + patternActions.length - 1,
            confidence: 1.0,
            data: {
                username,
                password,
                hasRememberMe
            }
        };
    }

    /**
     * Detect search pattern
     * Pattern: fill(criteria) → [fill(filters)] → click(search) → [assertion(results)]
     */
    private detectSearchPattern(actions: Action[], startIndex: number): SearchPattern | null {
        if (startIndex >= actions.length - 1) return null;

        const patternActions: Action[] = [];
        const searchFields: Array<{field: string; value: string}> = [];
        let hasFilters = false;
        let hasResults = false;

        // Look for search button
        let searchButtonIndex = -1;
        for (let i = startIndex; i < Math.min(startIndex + 10, actions.length); i++) {
            const action = actions[i];
            if (action.type === 'click') {
                const buttonName = action.target?.options?.name?.toLowerCase() || '';
                if (buttonName.includes('search')) {
                    searchButtonIndex = i;
                    break;
                }
            }
        }

        if (searchButtonIndex === -1) return null;

        // Collect fill actions before search button
        for (let i = startIndex; i < searchButtonIndex; i++) {
            const action = actions[i];
            if (action.type === 'fill') {
                const fieldName = action.target?.options?.name || 'field';
                const value = action.args[0] as string || '';
                searchFields.push({ field: fieldName, value });
                patternActions.push(action);
            }
            if (action.type === 'click') {
                // Dropdown/filter selection
                hasFilters = true;
                patternActions.push(action);
            }
        }

        // Add search button
        patternActions.push(actions[searchButtonIndex]);

        // Check for result assertion
        if (searchButtonIndex + 1 < actions.length) {
            const nextAction = actions[searchButtonIndex + 1];
            if (nextAction.type === 'assertion') {
                hasResults = true;
                patternActions.push(nextAction);
            }
        }

        if (patternActions.length < 2) return null;

        return {
            type: 'search',
            actions: patternActions,
            startIndex,
            endIndex: startIndex + patternActions.length - 1,
            confidence: 0.85,
            data: {
                searchFields,
                hasFilters,
                hasResults
            }
        };
    }

    /**
     * Detect navigation pattern
     * Pattern: click(link) → [assertion(heading)]
     */
    private detectNavigationPattern(actions: Action[], startIndex: number): NavigationPattern | null {
        if (startIndex >= actions.length) return null;

        const action = actions[startIndex];

        // Check if action is clicking a navigation link
        if (action.type !== 'click') return null;
        if (action.target?.type !== 'getByRole' || action.target.selector !== 'link') return null;

        const linkText = action.target.options?.name || '';

        // Check if this is a module navigation link
        const navigationModules = ['Admin', 'PIM', 'Leave', 'Time', 'Recruitment',
                                   'Performance', 'Dashboard', 'Directory', 'Maintenance'];

        const isModuleNav = navigationModules.some(m => linkText.includes(m));
        if (!isModuleNav) return null;

        const patternActions = [action];

        // Check for heading assertion (navigation verification)
        let verified = false;
        if (startIndex + 1 < actions.length) {
            const nextAction = actions[startIndex + 1];
            if (nextAction.type === 'assertion' &&
                nextAction.expression.includes('getByRole') &&
                nextAction.expression.includes('heading')) {
                verified = true;
                patternActions.push(nextAction);
            }
        }

        return {
            type: 'navigation',
            actions: patternActions,
            startIndex,
            endIndex: startIndex + patternActions.length - 1,
            confidence: 0.95,
            data: {
                linkText,
                targetModule: linkText,
                verified
            }
        };
    }

    /**
     * Extract dropdown context from surrounding actions/elements
     */
    private extractDropdownContext(dropdownAction: Action, optionText: string): string {
        // Try to infer from option text
        if (optionText.toLowerCase().includes('enable')) {
            return 'Status';
        }
        if (optionText.toLowerCase().includes('employee')) {
            return 'Employment Status';
        }
        if (optionText.toLowerCase().includes('admin') ||
            optionText.toLowerCase().includes('role')) {
            return 'User Role';
        }

        // Check selector for context
        const selector = dropdownAction.target?.selector || '';
        if (selector.includes('status')) {
            return 'Status';
        }
        if (selector.includes('role')) {
            return 'Role';
        }
        if (selector.includes('type')) {
            return 'Type';
        }

        return 'Filter';
    }

    /**
     * Check if action is part of any detected pattern
     */
    public isPartOfPattern(actionIndex: number, patterns: Pattern[]): Pattern | null {
        for (const pattern of patterns) {
            if (actionIndex >= pattern.startIndex && actionIndex <= pattern.endIndex) {
                return pattern;
            }
        }
        return null;
    }

    /**
     * Get pattern at specific index
     */
    public getPatternAtIndex(index: number, patterns: Pattern[]): Pattern | null {
        return patterns.find(p => p.startIndex === index) || null;
    }
}
