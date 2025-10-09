/**
 * Natural Language Processing Engine
 * Processes natural language descriptions to identify element intent, keywords, and visual cues
 */

import { NLPResult, IntentType, VisualCues, PositionCues } from '../types/AITypes';
import { CSReporter } from '../../reporter/CSReporter';

export class CSNaturalLanguageEngine {
    private static instance: CSNaturalLanguageEngine;
    private cache: Map<string, NLPResult> = new Map();
    private readonly cacheTimeout: number = 300000; // 5 minutes

    // Common action keywords mapped to intents
    private readonly actionKeywords: Map<string, IntentType> = new Map([
        ['click', 'click'], ['tap', 'click'], ['press', 'click'],
        ['type', 'type'], ['enter', 'type'], ['input', 'type'], ['fill', 'type'],
        ['choose', 'select'], ['pick', 'select'], ['dropdown', 'select'], ['select', 'select'],
        ['check', 'check'], ['tick', 'check'], ['mark', 'check'],
        ['uncheck', 'uncheck'], ['untick', 'uncheck'], ['unmark', 'uncheck'],
        ['hover', 'hover'], ['mouseover', 'hover'],
        ['navigate', 'navigate'], ['goto', 'navigate'], ['visit', 'navigate'], ['open', 'navigate'],
        ['verify', 'validate'], ['assert', 'validate'], ['validate', 'validate'],
        ['see', 'validate'], ['should', 'validate'], ['expect', 'validate'],
        ['display', 'validate'], ['show', 'validate'], ['visible', 'validate'], ['appear', 'validate'],
        ['contain', 'validate'], ['have', 'validate'], ['exist', 'validate'],
        ['extract', 'extract'], ['get', 'extract'], ['read', 'extract'],
        ['wait', 'wait'], ['pause', 'wait']
    ]);

    // Element type keywords
    private readonly elementTypes: Map<string, string> = new Map([
        ['button', 'button'], ['btn', 'button'],
        ['link', 'link'], ['anchor', 'link'], ['hyperlink', 'link'],
        ['input', 'input'], ['field', 'input'], ['textbox', 'input'],
        ['checkbox', 'checkbox'], ['check', 'checkbox'],
        ['radio', 'radio'],
        ['dropdown', 'select'], ['select', 'select'], ['combobox', 'select'],
        ['textarea', 'textarea'],
        ['image', 'image'], ['img', 'image'], ['picture', 'image'],
        ['icon', 'icon'],
        ['label', 'label'], ['text', 'text'],
        // Table elements (modern data grids)
        ['table', 'table'], ['grid', 'table'], ['datagrid', 'table'],
        ['row', 'row'], ['tr', 'row'],
        ['column', 'column'], ['col', 'column'],
        ['cell', 'cell'], ['td', 'cell'], ['th', 'cell'],
        ['header', 'header'], ['thead', 'header'],
        // Lists
        ['list', 'list'], ['listbox', 'list'],
        // Navigation
        ['menu', 'menu'], ['navigation', 'menu'], ['nav', 'menu'],
        ['menuitem', 'menuitem'],
        // Modals/Dialogs
        ['modal', 'modal'], ['dialog', 'dialog'], ['popup', 'modal'],
        ['alert', 'alert'], ['banner', 'banner'],
        // Forms
        ['form', 'form'],
        // Custom components (React/Angular/Vue)
        ['card', 'card'], ['panel', 'panel'],
        ['tab', 'tab'], ['tabs', 'tabs'],
        ['accordion', 'accordion'],
        ['slider', 'slider'], ['range', 'slider'],
        ['datepicker', 'datepicker'], ['date', 'datepicker'],
        ['tooltip', 'tooltip'],
        ['badge', 'badge'], ['tag', 'tag'],
        ['avatar', 'avatar'],
        // File uploads
        ['upload', 'upload'], ['file', 'upload'],
        // Search
        ['search', 'search'], ['searchbox', 'search']
    ]);

    // Color keywords
    private readonly colors: Set<string> = new Set([
        'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'black',
        'white', 'gray', 'grey', 'brown', 'cyan', 'magenta', 'lime', 'navy',
        'teal', 'olive', 'maroon', 'aqua', 'silver', 'gold'
    ]);

    // Size keywords
    private readonly sizes: Set<string> = new Set([
        'large', 'big', 'huge', 'giant', 'small', 'tiny', 'mini', 'medium'
    ]);

    // Shape keywords
    private readonly shapes: Set<string> = new Set([
        'round', 'circle', 'circular', 'square', 'rectangular', 'oval', 'triangle'
    ]);

    // Position keywords
    private readonly positions: Set<string> = new Set([
        'top', 'bottom', 'left', 'right', 'center', 'middle',
        'upper', 'lower', 'first', 'last'
    ]);

    // Relationship keywords
    private readonly relationships: Set<string> = new Set([
        'above', 'below', 'near', 'next', 'beside', 'inside', 'within',
        'after', 'before', 'under', 'over'
    ]);

    private constructor() {
        CSReporter.debug('[CSNaturalLanguageEngine] Initialized');
    }

    public static getInstance(): CSNaturalLanguageEngine {
        if (!CSNaturalLanguageEngine.instance) {
            CSNaturalLanguageEngine.instance = new CSNaturalLanguageEngine();
        }
        return CSNaturalLanguageEngine.instance;
    }

    /**
     * Process natural language description into structured NLP result
     */
    public async processDescription(description: string): Promise<NLPResult> {
        const cacheKey = description.toLowerCase().trim();

        // Check cache
        const cached = this.cache.get(cacheKey);
        if (cached) {
            CSReporter.debug(`[NLP] Cache hit for: "${description}"`);
            return cached;
        }

        const startTime = Date.now();
        CSReporter.debug(`[NLP] Processing: "${description}"`);

        // Tokenize
        const tokens = this.tokenize(description);

        // Extract intent
        const intent = this.extractIntent(tokens);

        // Extract keywords
        const keywords = this.extractKeywords(tokens);

        // Extract element type
        const elementType = this.extractElementType(tokens);

        // Extract visual cues
        const visualCues = this.extractVisualCues(tokens);

        // Extract position cues
        const positionCues = this.extractPositionCues(tokens);

        // Extract text content
        const textContent = this.extractTextContent(description);

        // Determine expected roles
        const expectedRoles = this.determineExpectedRoles(elementType, intent);

        // Check for form context
        const formContext = this.hasFormContext(tokens);

        // Calculate confidence
        const confidence = this.calculateConfidence(intent, elementType, keywords);

        const result: NLPResult = {
            intent,
            elementType,
            keywords,
            visualCues,
            positionCues,
            textContent,
            confidence,
            expectedRoles,
            formContext
        };

        // Cache result
        this.cache.set(cacheKey, result);
        setTimeout(() => this.cache.delete(cacheKey), this.cacheTimeout);

        const duration = Date.now() - startTime;
        CSReporter.debug(`[NLP] Processed in ${duration}ms - Intent: ${intent}, Type: ${elementType}, Confidence: ${confidence}`);

        return result;
    }

    /**
     * Tokenize description into words
     */
    private tokenize(description: string): string[] {
        return description
            .toLowerCase()
            .replace(/['"]/g, ' QUOTE ')  // Preserve quoted text markers
            .split(/\s+/)
            .filter(token => token.length > 0);
    }

    /**
     * Extract action intent from tokens
     */
    private extractIntent(tokens: string[]): IntentType {
        // Check first few tokens for action words
        for (let i = 0; i < Math.min(3, tokens.length); i++) {
            const intent = this.actionKeywords.get(tokens[i]);
            if (intent) {
                return intent;
            }
        }

        // Default intent based on context
        if (tokens.some(t => this.elementTypes.get(t) === 'button')) {
            return 'click';
        }
        if (tokens.some(t => this.elementTypes.get(t) === 'input')) {
            return 'type';
        }
        if (tokens.some(t => this.elementTypes.get(t) === 'select')) {
            return 'select';
        }

        // Default
        return 'click';
    }

    /**
     * Extract meaningful keywords
     */
    private extractKeywords(tokens: string[]): string[] {
        const keywords: string[] = [];
        const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'with']);

        for (const token of tokens) {
            if (token === 'QUOTE') continue;
            if (stopWords.has(token)) continue;
            if (token.length <= 2) continue;

            keywords.push(token);
        }

        return keywords;
    }

    /**
     * Extract element type from description
     */
    private extractElementType(tokens: string[]): string | undefined {
        for (const token of tokens) {
            const type = this.elementTypes.get(token);
            if (type) {
                return type;
            }
        }

        // Infer from combinations
        if (tokens.includes('submit') || tokens.includes('send')) {
            return 'button';
        }
        if (tokens.includes('email') || tokens.includes('password') || tokens.includes('username')) {
            return 'input';
        }

        return undefined;
    }

    /**
     * Extract visual cues (colors, sizes, shapes)
     */
    private extractVisualCues(tokens: string[]): VisualCues {
        const colors: string[] = [];
        const sizes: string[] = [];
        const shapes: string[] = [];

        for (const token of tokens) {
            if (this.colors.has(token)) {
                colors.push(token);
            }
            if (this.sizes.has(token)) {
                sizes.push(token);
            }
            if (this.shapes.has(token)) {
                shapes.push(token);
            }
        }

        return {
            colors: colors.length > 0 ? colors : undefined,
            sizes: sizes.length > 0 ? sizes : undefined,
            shapes: shapes.length > 0 ? shapes : undefined
        };
    }

    /**
     * Extract position cues and relationships
     */
    private extractPositionCues(tokens: string[]): PositionCues {
        const cues: PositionCues = {};

        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];

            // Position
            if (this.positions.has(token)) {
                cues.position = token;
            }

            // Relationship
            if (this.relationships.has(token)) {
                cues.relation = token;

                // Get the reference element (next few tokens)
                const reference = tokens.slice(i + 1, i + 4).join(' ');
                if (reference) {
                    cues.relativeTo = reference;
                }
            }
        }

        return cues;
    }

    /**
     * Extract quoted text content
     */
    private extractTextContent(description: string): string | undefined {
        const matches = description.match(/["']([^"']+)["']/);
        return matches ? matches[1] : undefined;
    }

    /**
     * Determine expected ARIA roles based on element type
     */
    private determineExpectedRoles(elementType: string | undefined, intent: IntentType): string[] | undefined {
        if (!elementType) return undefined;

        const roleMap: Record<string, string[]> = {
            'button': ['button', 'link'],
            'link': ['link', 'button'],
            'input': ['textbox', 'searchbox', 'combobox'],
            'checkbox': ['checkbox'],
            'radio': ['radio'],
            'select': ['combobox', 'listbox'],
            'menu': ['menu', 'menubar', 'navigation'],
            'dialog': ['dialog', 'alertdialog'],
            'table': ['table', 'grid']
        };

        return roleMap[elementType];
    }

    /**
     * Check if description mentions form-related context
     */
    private hasFormContext(tokens: string[]): boolean {
        const formKeywords = ['form', 'login', 'signup', 'register', 'submit', 'email', 'password'];
        return tokens.some(token => formKeywords.includes(token));
    }

    /**
     * Calculate confidence score based on extracted information
     */
    private calculateConfidence(
        intent: IntentType,
        elementType: string | undefined,
        keywords: string[]
    ): number {
        let confidence = 0.5; // Base confidence

        // Has clear intent
        if (intent !== 'click' || keywords.some(k => this.actionKeywords.has(k))) {
            confidence += 0.1;
        }

        // Has element type
        if (elementType) {
            confidence += 0.2;
        }

        // Has meaningful keywords
        if (keywords.length >= 2) {
            confidence += 0.1;
        }

        // Has visual cues
        if (keywords.some(k => this.colors.has(k) || this.sizes.has(k))) {
            confidence += 0.1;
        }

        return Math.min(confidence, 1.0);
    }

    /**
     * Clear cache (for testing or memory management)
     */
    public clearCache(): void {
        this.cache.clear();
        CSReporter.debug('[NLP] Cache cleared');
    }

    /**
     * Get cache statistics
     */
    public getCacheStats(): { size: number; timeout: number } {
        return {
            size: this.cache.size,
            timeout: this.cacheTimeout
        };
    }
}
