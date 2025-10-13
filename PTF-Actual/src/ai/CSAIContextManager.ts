/**
 * AI Context Manager - Determines when AI healing should be activated
 * ONLY activates for UI-based steps, not for API or database operations
 */

import { CSReporter } from '../reporter/CSReporter';

export type ExecutionContext = 'ui' | 'api' | 'database' | 'unknown';

export class CSAIContextManager {
    private static instance: CSAIContextManager;
    private currentContext: ExecutionContext = 'unknown';
    private contextStack: ExecutionContext[] = [];

    private constructor() {
        CSReporter.debug('[CSAIContextManager] Initialized');
    }

    public static getInstance(): CSAIContextManager {
        if (!CSAIContextManager.instance) {
            CSAIContextManager.instance = new CSAIContextManager();
        }
        return CSAIContextManager.instance;
    }

    /**
     * Set the current execution context
     */
    public setContext(context: ExecutionContext): void {
        this.contextStack.push(this.currentContext);
        this.currentContext = context;
        CSReporter.debug(`[AIContext] Context set to: ${context}`);
    }

    /**
     * Restore previous context
     */
    public popContext(): void {
        const previous = this.contextStack.pop();
        if (previous) {
            this.currentContext = previous;
            CSReporter.debug(`[AIContext] Context restored to: ${previous}`);
        }
    }

    /**
     * Get current execution context
     */
    public getCurrentContext(): ExecutionContext {
        return this.currentContext;
    }

    /**
     * Check if AI healing should be enabled for current context
     * ONLY return true for UI-based operations
     */
    public isAIHealingEnabled(): boolean {
        const enabled = this.currentContext === 'ui';

        if (!enabled && this.currentContext !== 'unknown') {
            CSReporter.debug(`[AIContext] AI healing DISABLED for ${this.currentContext} context - using existing retry behavior`);
        }

        return enabled;
    }

    /**
     * Detect context from step text
     */
    public detectContextFromStep(stepText: string): ExecutionContext {
        const lowerStep = stepText.toLowerCase();

        // API keywords
        if (lowerStep.includes('api') ||
            lowerStep.includes('request') ||
            lowerStep.includes('response') ||
            lowerStep.includes('endpoint') ||
            lowerStep.includes('post') && lowerStep.includes('body') ||
            lowerStep.includes('get') && lowerStep.includes('header') ||
            lowerStep.includes('rest') ||
            lowerStep.includes('graphql') ||
            lowerStep.includes('soap')) {
            return 'api';
        }

        // Database keywords
        if (lowerStep.includes('database') ||
            lowerStep.includes('query') ||
            lowerStep.includes('sql') ||
            lowerStep.includes('insert') ||
            lowerStep.includes('update') ||
            lowerStep.includes('delete') && lowerStep.includes('record') ||
            lowerStep.includes('select') && lowerStep.includes('from') ||
            lowerStep.includes('mongodb') ||
            lowerStep.includes('collection')) {
            return 'database';
        }

        // UI keywords
        if (lowerStep.includes('click') ||
            lowerStep.includes('type') ||
            lowerStep.includes('enter') ||
            lowerStep.includes('select') ||
            lowerStep.includes('button') ||
            lowerStep.includes('input') ||
            lowerStep.includes('field') ||
            lowerStep.includes('page') ||
            lowerStep.includes('navigate') ||
            lowerStep.includes('see') ||
            lowerStep.includes('visible') ||
            lowerStep.includes('displayed') ||
            lowerStep.includes('checkbox') ||
            lowerStep.includes('radio') ||
            lowerStep.includes('dropdown') ||
            lowerStep.includes('scroll') ||
            lowerStep.includes('hover') ||
            lowerStep.includes('menu') ||
            lowerStep.includes('option') ||
            lowerStep.includes('item') ||
            lowerStep.includes('link') ||
            lowerStep.includes('tab') ||
            lowerStep.includes('header') ||
            lowerStep.includes('footer') ||
            lowerStep.includes('modal') ||
            lowerStep.includes('dialog') ||
            lowerStep.includes('popup') ||
            lowerStep.includes('form') ||
            lowerStep.includes('label') ||
            lowerStep.includes('text') ||
            lowerStep.includes('image') ||
            lowerStep.includes('icon') ||
            lowerStep.includes('dashboard') ||
            lowerStep.includes('login') ||
            lowerStep.includes('logout') ||
            lowerStep.includes('profile') ||
            lowerStep.includes('sidebar') ||
            lowerStep.includes('navigation')) {
            return 'ui';
        }

        // Default to UI if not clearly API/Database (most steps are UI in BDD tests)
        return 'ui';
    }

    /**
     * Auto-detect and set context from step
     */
    public autoDetectContext(stepText: string): ExecutionContext {
        const detected = this.detectContextFromStep(stepText);
        this.setContext(detected);
        return detected;
    }

    /**
     * Reset context to unknown
     */
    public resetContext(): void {
        this.currentContext = 'unknown';
        this.contextStack = [];
        CSReporter.debug('[AIContext] Context reset to unknown');
    }

    /**
     * Check if step is UI-based (static helper)
     */
    public static isUIStep(stepText: string): boolean {
        const manager = CSAIContextManager.getInstance();
        const context = manager.detectContextFromStep(stepText);
        return context === 'ui';
    }

    /**
     * Check if step is API-based (static helper)
     */
    public static isAPIStep(stepText: string): boolean {
        const manager = CSAIContextManager.getInstance();
        const context = manager.detectContextFromStep(stepText);
        return context === 'api';
    }

    /**
     * Check if step is database-based (static helper)
     */
    public static isDatabaseStep(stepText: string): boolean {
        const manager = CSAIContextManager.getInstance();
        const context = manager.detectContextFromStep(stepText);
        return context === 'database';
    }
}
