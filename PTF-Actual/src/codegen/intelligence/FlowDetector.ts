/**
 * FlowDetector - Intelligent Flow and Page Boundary Detection
 *
 * Detects common UI flows (login, search, CRUD) and page boundaries.
 * Groups related actions into business flows.
 */

import { Action } from '../types';

export interface DetectedFlow {
    type: FlowType;
    name: string;
    actions: Action[];
    startIndex: number;
    endIndex: number;
    confidence: number;
    suggestedMethodName: string;
    suggestedStepPattern: string;
}

export interface PageBoundary {
    pageName: string;
    startIndex: number;
    endIndex: number;
    url?: string;
    detectionReason: string;
}

export type FlowType =
    | 'login'
    | 'logout'
    | 'search'
    | 'navigation'
    | 'form-submit'
    | 'crud-create'
    | 'crud-read'
    | 'crud-update'
    | 'crud-delete'
    | 'file-upload'
    | 'dropdown-select'
    | 'modal-interaction'
    | 'table-interaction'
    | 'verification'
    | 'generic';

export class FlowDetector {
    // Flow patterns with their signatures
    private static readonly FLOW_PATTERNS: Array<{
        type: FlowType;
        name: string;
        patterns: FlowPattern[];
    }> = [
        {
            type: 'login',
            name: 'Login',
            patterns: [
                { sequence: ['fill:username', 'fill:password', 'click:login'], confidence: 0.95 },
                { sequence: ['fill:user', 'fill:pass', 'click:log'], confidence: 0.90 },
                { sequence: ['fill:email', 'fill:password', 'click:sign'], confidence: 0.90 },
                { sequence: ['fill', 'fill', 'click:submit'], confidence: 0.70 },
            ],
        },
        {
            type: 'logout',
            name: 'Logout',
            patterns: [
                { sequence: ['click:logout'], confidence: 0.95 },
                { sequence: ['click:sign out'], confidence: 0.95 },
                { sequence: ['click:log out'], confidence: 0.95 },
            ],
        },
        {
            type: 'search',
            name: 'Search',
            patterns: [
                { sequence: ['fill:search', 'click:search'], confidence: 0.90 },
                { sequence: ['fill:search', 'press:Enter'], confidence: 0.90 },
                { sequence: ['fill:query', 'click:find'], confidence: 0.85 },
                { sequence: ['fill', 'click:search'], confidence: 0.75 },
            ],
        },
        {
            type: 'form-submit',
            name: 'Form Submit',
            patterns: [
                { sequence: ['fill', 'fill', 'click:submit'], confidence: 0.80 },
                { sequence: ['fill', 'fill', 'fill', 'click:save'], confidence: 0.80 },
                { sequence: ['fill', 'click:confirm'], confidence: 0.75 },
            ],
        },
        {
            type: 'file-upload',
            name: 'File Upload',
            patterns: [
                { sequence: ['click:upload', 'setInputFiles'], confidence: 0.95 },
                { sequence: ['click:browse', 'setInputFiles'], confidence: 0.95 },
                { sequence: ['click:add file', 'setInputFiles'], confidence: 0.95 },
                { sequence: ['setInputFiles'], confidence: 0.90 },
            ],
        },
        {
            type: 'dropdown-select',
            name: 'Dropdown Selection',
            patterns: [
                { sequence: ['click:dropdown', 'click:option'], confidence: 0.85 },
                { sequence: ['click:select', 'click'], confidence: 0.80 },
                { sequence: ['selectOption'], confidence: 0.95 },
            ],
        },
        {
            type: 'modal-interaction',
            name: 'Modal Interaction',
            patterns: [
                { sequence: ['click', 'toBeVisible:modal', 'click:close'], confidence: 0.85 },
                { sequence: ['click', 'toBeVisible:dialog', 'click:ok'], confidence: 0.85 },
                { sequence: ['click:cancel'], confidence: 0.70 },
                { sequence: ['click:confirm'], confidence: 0.70 },
            ],
        },
    ];

    // Page detection patterns
    private static readonly PAGE_PATTERNS: Array<{
        pattern: RegExp;
        pageName: string;
    }> = [
        { pattern: /login|signin|sign-in|authenticate/i, pageName: 'Login' },
        { pattern: /home|dashboard|main/i, pageName: 'Dashboard' },
        { pattern: /admin|administration/i, pageName: 'Admin' },
        { pattern: /user|profile|account/i, pageName: 'User' },
        { pattern: /setting|preference|config/i, pageName: 'Settings' },
        { pattern: /search|find|query/i, pageName: 'Search' },
        { pattern: /report|analytics/i, pageName: 'Reports' },
        { pattern: /list|table|grid/i, pageName: 'List' },
        { pattern: /detail|view|show/i, pageName: 'Details' },
        { pattern: /create|new|add/i, pageName: 'Create' },
        { pattern: /edit|update|modify/i, pageName: 'Edit' },
    ];

    /**
     * Detect flows in action sequence
     */
    public static detectFlows(actions: Action[]): DetectedFlow[] {
        const flows: DetectedFlow[] = [];
        const usedIndices = new Set<number>();

        // Try to match each flow pattern
        for (const flowDef of this.FLOW_PATTERNS) {
            for (const pattern of flowDef.patterns) {
                const matches = this.findPatternMatches(actions, pattern, usedIndices);

                for (const match of matches) {
                    flows.push({
                        type: flowDef.type,
                        name: flowDef.name,
                        actions: match.actions,
                        startIndex: match.startIndex,
                        endIndex: match.endIndex,
                        confidence: match.confidence,
                        suggestedMethodName: this.generateMethodName(flowDef.type, match.actions),
                        suggestedStepPattern: this.generateStepPattern(flowDef.type, match.actions),
                    });

                    // Mark indices as used
                    for (let i = match.startIndex; i <= match.endIndex; i++) {
                        usedIndices.add(i);
                    }
                }
            }
        }

        // Sort by start index
        flows.sort((a, b) => a.startIndex - b.startIndex);

        return flows;
    }

    /**
     * Detect page boundaries
     */
    public static detectPageBoundaries(actions: Action[]): PageBoundary[] {
        const boundaries: PageBoundary[] = [];
        let currentPage = 'Page';
        let currentPageStart = 0;

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            let newPage: string | null = null;
            let reason = '';

            // Check for navigation (goto)
            if (action.type === 'navigation' && action.method === 'goto') {
                const url = action.args[0] as string;
                newPage = this.extractPageFromUrl(url);
                reason = `Navigation to: ${url}`;
            }

            // Check for link clicks that suggest page change
            if (action.type === 'click' && action.target?.type === 'getByRole' &&
                action.target?.selector === 'link') {
                const linkName = action.target?.options?.name || '';
                newPage = this.extractPageFromLinkName(linkName);
                if (newPage) {
                    reason = `Clicked link: ${linkName}`;
                }
            }

            // Check for menu/navigation clicks
            if (action.type === 'click') {
                const clickTarget = this.getClickTargetName(action);
                if (this.isNavigationElement(clickTarget)) {
                    newPage = this.extractPageFromLinkName(clickTarget);
                    if (newPage) {
                        reason = `Clicked navigation: ${clickTarget}`;
                    }
                }
            }

            // If page changed, record boundary
            if (newPage && newPage !== currentPage) {
                if (i > currentPageStart) {
                    boundaries.push({
                        pageName: currentPage,
                        startIndex: currentPageStart,
                        endIndex: i - 1,
                        detectionReason: reason,
                    });
                }
                currentPage = newPage;
                currentPageStart = i;
            }
        }

        // Add final page boundary
        if (actions.length > 0) {
            boundaries.push({
                pageName: currentPage,
                startIndex: currentPageStart,
                endIndex: actions.length - 1,
                detectionReason: 'End of recording',
            });
        }

        return boundaries;
    }

    /**
     * Find pattern matches in actions
     */
    private static findPatternMatches(
        actions: Action[],
        pattern: FlowPattern,
        usedIndices: Set<number>
    ): Array<{ actions: Action[]; startIndex: number; endIndex: number; confidence: number }> {
        const matches: Array<{ actions: Action[]; startIndex: number; endIndex: number; confidence: number }> = [];
        const sequence = pattern.sequence;

        for (let i = 0; i <= actions.length - sequence.length; i++) {
            // Skip if any index already used
            let anyUsed = false;
            for (let j = 0; j < sequence.length; j++) {
                if (usedIndices.has(i + j)) {
                    anyUsed = true;
                    break;
                }
            }
            if (anyUsed) continue;

            // Check if pattern matches
            let matchScore = 0;
            let matchedActions: Action[] = [];

            for (let j = 0; j < sequence.length; j++) {
                const patternPart = sequence[j];
                const action = actions[i + j];

                if (this.matchesPatternPart(action, patternPart)) {
                    matchScore++;
                    matchedActions.push(action);
                } else {
                    break;
                }
            }

            // If full pattern matched
            if (matchScore === sequence.length) {
                matches.push({
                    actions: matchedActions,
                    startIndex: i,
                    endIndex: i + sequence.length - 1,
                    confidence: pattern.confidence,
                });
            }
        }

        return matches;
    }

    /**
     * Check if action matches pattern part
     */
    private static matchesPatternPart(action: Action, patternPart: string): boolean {
        const [method, target] = patternPart.split(':');

        // Check method
        if (action.method !== method && action.type !== method) {
            // Special case: fill matches type
            if (method === 'fill' && action.method !== 'fill' && action.method !== 'type') {
                return false;
            }
            if (method !== 'fill' && action.method !== method) {
                return false;
            }
        }

        // If no target specified, method match is enough
        if (!target) return true;

        // Check target
        const actionTarget = this.getActionTargetName(action).toLowerCase();
        return actionTarget.includes(target.toLowerCase());
    }

    /**
     * Get action target name for matching
     */
    private static getActionTargetName(action: Action): string {
        if (action.target?.options?.name) {
            return action.target.options.name;
        }
        if (action.target?.selector) {
            return action.target.selector;
        }
        return '';
    }

    /**
     * Get click target name
     */
    private static getClickTargetName(action: Action): string {
        if (action.target?.options?.name) {
            return action.target.options.name;
        }
        return '';
    }

    /**
     * Check if element is a navigation element
     */
    private static isNavigationElement(name: string): boolean {
        const navKeywords = [
            'admin', 'administration', 'dashboard', 'home', 'settings',
            'user', 'profile', 'reports', 'maintenance', 'menu',
        ];
        const lowerName = name.toLowerCase();
        return navKeywords.some(kw => lowerName.includes(kw));
    }

    /**
     * Extract page name from URL
     */
    private static extractPageFromUrl(url: string): string {
        for (const { pattern, pageName } of this.PAGE_PATTERNS) {
            if (pattern.test(url)) {
                return pageName;
            }
        }

        // Try to extract from path
        try {
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split('/').filter(p => p);
            if (pathParts.length > 0) {
                const lastPart = pathParts[pathParts.length - 1];
                return this.toPascalCase(lastPart);
            }
        } catch {
            // Invalid URL
        }

        return 'Page';
    }

    /**
     * Extract page name from link name
     */
    private static extractPageFromLinkName(linkName: string): string | null {
        for (const { pattern, pageName } of this.PAGE_PATTERNS) {
            if (pattern.test(linkName)) {
                return pageName;
            }
        }

        // Use link name directly if it looks like a page name
        if (linkName && linkName.length > 2 && linkName.length < 30) {
            return this.toPascalCase(linkName);
        }

        return null;
    }

    /**
     * Generate method name for flow
     */
    private static generateMethodName(flowType: FlowType, actions: Action[]): string {
        switch (flowType) {
            case 'login':
                return 'performLogin';
            case 'logout':
                return 'performLogout';
            case 'search':
                const searchField = this.getActionTargetName(actions[0]);
                return `searchBy${this.toPascalCase(searchField)}`;
            case 'form-submit':
                return 'submitForm';
            case 'file-upload':
                return 'uploadFile';
            case 'dropdown-select':
                return 'selectFromDropdown';
            default:
                return 'performAction';
        }
    }

    /**
     * Generate step pattern for flow
     */
    private static generateStepPattern(flowType: FlowType, actions: Action[]): string {
        switch (flowType) {
            case 'login':
                return 'user logs in with username {string} and password {string}';
            case 'logout':
                return 'user logs out';
            case 'search':
                return 'user searches for {string}';
            case 'form-submit':
                return 'user submits the form';
            case 'file-upload':
                return 'user uploads file {string}';
            case 'dropdown-select':
                return 'user selects {string} from dropdown';
            default:
                return 'user performs action';
        }
    }

    /**
     * Convert to PascalCase
     */
    private static toPascalCase(str: string): string {
        return str
            .replace(/[^a-zA-Z0-9]+/g, ' ')
            .split(' ')
            .filter(w => w)
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join('');
    }
}

interface FlowPattern {
    sequence: string[];
    confidence: number;
}

export default FlowDetector;
