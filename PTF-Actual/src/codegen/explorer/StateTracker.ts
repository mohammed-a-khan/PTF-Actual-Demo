/**
 * State Tracker
 * Tracks application states and transitions during exploration
 *
 * @module StateTracker
 */

import { Page } from 'playwright';
import * as crypto from 'crypto';
import {
    ApplicationState,
    StateTransition,
    InteractiveElement,
    FormDescriptor,
    TableDescriptor,
    ModalDescriptor,
    PageType,
    CapturedAPI,
    SuggestedAssertion,
    ActionType,
} from './types';
import { DOMDiscoveryEngine } from './DOMDiscoveryEngine';

export class StateTracker {
    private states: Map<string, ApplicationState> = new Map();
    private transitions: Map<string, StateTransition> = new Map();
    private currentStateId: string | null = null;
    private domEngine: DOMDiscoveryEngine;
    private visitedUrls: Set<string> = new Set();

    constructor() {
        this.domEngine = new DOMDiscoveryEngine();
    }

    /**
     * Capture current application state
     */
    async captureState(page: Page): Promise<ApplicationState> {
        this.domEngine.setPage(page);

        // Get basic page info
        const url = page.url();
        const title = await page.title();

        // Generate URL pattern (normalize dynamic parts)
        const urlPattern = this.normalizeUrl(url);

        // Generate hashes for comparison
        const domHash = await this.domEngine.generateDOMHash();
        const contentHash = await this.domEngine.generateContentHash();

        // Check if state already exists
        const stateId = this.generateStateId(urlPattern, domHash);
        const existingState = this.states.get(stateId);

        if (existingState) {
            existingState.lastVisited = new Date();
            this.currentStateId = stateId;
            return existingState;
        }

        // Discover page elements
        const interactiveElements = await this.domEngine.discoverElements({
            includeHidden: false,
            includeDisabled: false,
            maxElements: 200,
        });

        const forms = await this.domEngine.discoverForms();
        const tables = await this.domEngine.discoverTables();
        const modals = await this.domEngine.discoverModals();

        // Detect page type
        const pageType = this.detectPageType(url, title, interactiveElements, forms, tables);

        // Detect business entity
        const businessEntity = this.detectBusinessEntity(url, title, tables);

        // Check authentication state
        const isAuthenticated = await this.checkAuthenticationState(page);

        // Create new state
        const state: ApplicationState = {
            id: stateId,
            url,
            urlPattern,
            title,
            domHash,
            contentHash,
            pageType,
            businessEntity,
            interactiveElements,
            forms,
            tables,
            modals,
            isAuthenticated,
            discoveredAt: new Date(),
            lastVisited: new Date(),
            incomingTransitions: [],
            outgoingTransitions: [],
        };

        this.states.set(stateId, state);
        this.visitedUrls.add(urlPattern);
        this.currentStateId = stateId;

        return state;
    }

    /**
     * Record a state transition
     */
    recordTransition(
        fromStateId: string,
        toStateId: string,
        action: {
            type: ActionType;
            elementId: string;
            locator: string;
            value?: string;
        },
        apiCalls: CapturedAPI[] = [],
        duration: number = 0
    ): StateTransition {
        const transitionId = `${fromStateId}->${toStateId}-${action.elementId}`;

        // Generate suggested assertions based on the transition
        const suggestedAssertions = this.generateAssertions(fromStateId, toStateId, action);

        const transition: StateTransition = {
            id: transitionId,
            fromStateId,
            toStateId,
            action,
            apiCalls,
            suggestedAssertions,
            timestamp: new Date(),
            duration,
        };

        this.transitions.set(transitionId, transition);

        // Update state connections
        const fromState = this.states.get(fromStateId);
        const toState = this.states.get(toStateId);

        if (fromState && !fromState.outgoingTransitions.includes(transitionId)) {
            fromState.outgoingTransitions.push(transitionId);
        }

        if (toState && !toState.incomingTransitions.includes(transitionId)) {
            toState.incomingTransitions.push(transitionId);
        }

        return transition;
    }

    /**
     * Check if a state has been visited
     */
    hasState(stateId: string): boolean {
        return this.states.has(stateId);
    }

    /**
     * Check if a URL pattern has been visited
     */
    hasVisitedUrl(url: string): boolean {
        const pattern = this.normalizeUrl(url);
        return this.visitedUrls.has(pattern);
    }

    /**
     * Get all states
     */
    getStates(): ApplicationState[] {
        return Array.from(this.states.values());
    }

    /**
     * Get all transitions
     */
    getTransitions(): StateTransition[] {
        return Array.from(this.transitions.values());
    }

    /**
     * Get current state
     */
    getCurrentState(): ApplicationState | null {
        if (!this.currentStateId) return null;
        return this.states.get(this.currentStateId) || null;
    }

    /**
     * Get unexplored elements from current state
     */
    getUnexploredElements(stateId: string): InteractiveElement[] {
        const state = this.states.get(stateId);
        if (!state) return [];

        // Get all element IDs that have been used in transitions from this state
        const exploredElementIds = new Set(
            state.outgoingTransitions
                .map(tid => this.transitions.get(tid))
                .filter(Boolean)
                .map(t => t!.action.elementId)
        );

        // Return elements that haven't been explored
        return state.interactiveElements.filter(el => !exploredElementIds.has(el.id));
    }

    /**
     * Generate unique state ID
     */
    private generateStateId(urlPattern: string, domHash: string): string {
        const key = `${urlPattern}-${domHash}`;
        return crypto.createHash('md5').update(key).digest('hex').substring(0, 16);
    }

    /**
     * Normalize URL to create pattern (replace IDs with placeholders)
     */
    private normalizeUrl(url: string): string {
        try {
            const parsed = new URL(url);

            // Replace numeric IDs in path
            let path = parsed.pathname
                .replace(/\/\d+/g, '/{id}')
                .replace(/\/[a-f0-9]{24}/gi, '/{id}') // MongoDB ObjectId
                .replace(/\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '/{uuid}'); // UUID

            // Normalize query params (sort them)
            const params = new URLSearchParams(parsed.search);
            const sortedParams: string[] = [];
            params.forEach((_, key) => sortedParams.push(key));
            sortedParams.sort();

            const normalizedSearch = sortedParams.length > 0
                ? '?' + sortedParams.map(k => `${k}=*`).join('&')
                : '';

            return `${parsed.origin}${path}${normalizedSearch}`;
        } catch {
            return url;
        }
    }

    /**
     * Detect page type from content
     */
    private detectPageType(
        url: string,
        title: string,
        elements: InteractiveElement[],
        forms: FormDescriptor[],
        tables: TableDescriptor[]
    ): PageType {
        const urlLower = url.toLowerCase();
        const titleLower = title.toLowerCase();

        // URL-based detection
        if (urlLower.includes('/login') || urlLower.includes('/signin')) return 'login';
        if (urlLower.includes('/register') || urlLower.includes('/signup')) return 'register';
        if (urlLower.includes('/dashboard')) return 'dashboard';
        if (urlLower.includes('/settings') || urlLower.includes('/preferences')) return 'settings';
        if (urlLower.includes('/profile') || urlLower.includes('/account')) return 'profile';
        if (urlLower.includes('/search')) return 'search';
        if (urlLower.includes('/cart') || urlLower.includes('/basket')) return 'cart';
        if (urlLower.includes('/checkout')) return 'checkout';
        if (urlLower.includes('/error') || urlLower.includes('/404') || urlLower.includes('/500')) return 'error';

        // Form-based detection
        if (forms.length > 0) {
            const formTypes = forms.map(f => f.formType);
            if (formTypes.includes('login')) return 'login';
            if (formTypes.includes('register')) return 'register';
            if (formTypes.includes('search')) return 'search';
            if (formTypes.includes('checkout')) return 'checkout';
            if (formTypes.includes('crud')) return 'form';
        }

        // Table-based detection
        if (tables.length > 0 && tables[0].rowCount > 5) {
            return 'list';
        }

        // Element-based detection
        const purposes = elements.map(e => e.purpose);
        if (purposes.includes('login')) return 'login';
        if (purposes.includes('search')) return 'search';

        // Title-based detection
        if (titleLower.includes('login') || titleLower.includes('sign in')) return 'login';
        if (titleLower.includes('register') || titleLower.includes('sign up')) return 'register';
        if (titleLower.includes('dashboard')) return 'dashboard';
        if (titleLower.includes('error') || titleLower.includes('not found')) return 'error';

        // Default based on content
        if (forms.length > 0) return 'form';
        if (tables.length > 0) return 'list';

        return 'unknown';
    }

    /**
     * Detect business entity from page content
     */
    private detectBusinessEntity(
        url: string,
        title: string,
        tables: TableDescriptor[]
    ): string | undefined {
        const text = `${url} ${title}`.toLowerCase();

        // Common entity patterns
        const entities = [
            'user', 'customer', 'employee', 'admin',
            'product', 'item', 'article', 'post',
            'order', 'invoice', 'transaction', 'payment',
            'category', 'tag', 'label',
            'project', 'task', 'ticket', 'issue',
            'message', 'notification', 'comment',
            'file', 'document', 'report',
            'setting', 'configuration', 'preference',
        ];

        for (const entity of entities) {
            if (text.includes(entity)) {
                return entity.charAt(0).toUpperCase() + entity.slice(1);
            }
        }

        // Try to infer from table headers
        if (tables.length > 0) {
            const headers = tables[0].headers.join(' ').toLowerCase();
            for (const entity of entities) {
                if (headers.includes(entity)) {
                    return entity.charAt(0).toUpperCase() + entity.slice(1);
                }
            }
        }

        return undefined;
    }

    /**
     * Check if user is authenticated
     */
    private async checkAuthenticationState(page: Page): Promise<boolean> {
        try {
            // Check for common authentication indicators
            const indicators = await page.evaluate(() => {
                const body = document.body.innerText.toLowerCase();
                const hasLogout = body.includes('logout') || body.includes('sign out') || body.includes('log out');
                const hasProfile = document.querySelector('[class*="profile"], [class*="avatar"], [class*="user-menu"]') !== null;
                const hasWelcome = body.includes('welcome') || body.includes('hello');

                // Check for login form (indicates NOT authenticated)
                const hasLoginForm = document.querySelector('form input[type="password"]') !== null &&
                    (body.includes('login') || body.includes('sign in'));

                return {
                    hasLogout,
                    hasProfile,
                    hasWelcome,
                    hasLoginForm,
                };
            });

            // More likely authenticated if has logout/profile and no login form
            if (indicators.hasLoginForm) {
                return false;
            }

            return indicators.hasLogout || indicators.hasProfile || indicators.hasWelcome;
        } catch {
            return false;
        }
    }

    /**
     * Generate assertions based on state transition
     */
    private generateAssertions(
        fromStateId: string,
        toStateId: string,
        action: { type: ActionType; elementId: string; locator: string; value?: string }
    ): SuggestedAssertion[] {
        const assertions: SuggestedAssertion[] = [];
        const toState = this.states.get(toStateId);
        const fromState = this.states.get(fromStateId);

        if (!toState) return assertions;

        // URL change assertion
        if (fromState && fromState.url !== toState.url) {
            assertions.push({
                type: 'url',
                target: 'page',
                expected: toState.url,
                confidence: 90,
                gherkinStep: `Then the URL should contain "${new URL(toState.url).pathname}"`,
                playwrightCode: `await expect(page).toHaveURL(/${this.escapeRegex(new URL(toState.url).pathname)}/)`,
            });
        }

        // Title assertion
        if (toState.title) {
            assertions.push({
                type: 'title',
                target: 'page',
                expected: toState.title,
                confidence: 80,
                gherkinStep: `Then the page title should be "${toState.title}"`,
                playwrightCode: `await expect(page).toHaveTitle("${toState.title}")`,
            });
        }

        // Page type specific assertions
        switch (toState.pageType) {
            case 'list':
                if (toState.tables.length > 0) {
                    assertions.push({
                        type: 'visibility',
                        target: 'table',
                        expected: true,
                        confidence: 85,
                        gherkinStep: 'Then a data table should be visible',
                        playwrightCode: `await expect(page.locator('table')).toBeVisible()`,
                    });
                }
                break;

            case 'form':
                if (toState.forms.length > 0) {
                    assertions.push({
                        type: 'visibility',
                        target: 'form',
                        expected: true,
                        confidence: 85,
                        gherkinStep: 'Then a form should be visible',
                        playwrightCode: `await expect(page.locator('form')).toBeVisible()`,
                    });
                }
                break;

            case 'error':
                assertions.push({
                    type: 'text',
                    target: 'error message',
                    expected: 'error',
                    confidence: 75,
                    gherkinStep: 'Then an error message should be displayed',
                    playwrightCode: `await expect(page.locator('[class*="error"], [role="alert"]')).toBeVisible()`,
                });
                break;
        }

        // Action-specific assertions
        if (action.type === 'fill' && action.value) {
            assertions.push({
                type: 'value',
                target: action.locator,
                expected: action.value,
                confidence: 70,
                gherkinStep: `Then the field should contain "${action.value}"`,
                playwrightCode: `await expect(page.locator('${action.locator}')).toHaveValue("${action.value}")`,
            });
        }

        return assertions;
    }

    /**
     * Escape regex special characters
     */
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Get exploration statistics
     */
    getStatistics(): {
        totalStates: number;
        totalTransitions: number;
        uniqueUrls: number;
        statesByPageType: Record<string, number>;
        averageElementsPerState: number;
    } {
        const states = this.getStates();
        const statesByPageType: Record<string, number> = {};

        let totalElements = 0;
        for (const state of states) {
            totalElements += state.interactiveElements.length;
            statesByPageType[state.pageType] = (statesByPageType[state.pageType] || 0) + 1;
        }

        return {
            totalStates: states.length,
            totalTransitions: this.transitions.size,
            uniqueUrls: this.visitedUrls.size,
            statesByPageType,
            averageElementsPerState: states.length > 0 ? Math.round(totalElements / states.length) : 0,
        };
    }

    /**
     * Export state machine for visualization
     */
    exportStateMachine(): { nodes: any[]; edges: any[] } {
        const nodes = this.getStates().map(state => ({
            id: state.id,
            label: state.title || state.urlPattern,
            type: state.pageType,
            url: state.urlPattern,
        }));

        const edges = this.getTransitions().map(transition => ({
            id: transition.id,
            source: transition.fromStateId,
            target: transition.toStateId,
            label: transition.action.type,
        }));

        return { nodes, edges };
    }

    /**
     * Clear all tracked state
     */
    clear(): void {
        this.states.clear();
        this.transitions.clear();
        this.visitedUrls.clear();
        this.currentStateId = null;
    }
}

export default StateTracker;
