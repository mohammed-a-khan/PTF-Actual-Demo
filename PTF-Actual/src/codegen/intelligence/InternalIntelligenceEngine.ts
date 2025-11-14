/**
 * Internal Intelligence Engine
 *
 * A self-contained AI-like system that uses advanced algorithms, pattern matching,
 * semantic analysis, and rule-based reasoning WITHOUT any external API calls.
 *
 * This system is designed for enterprise environments that prohibit external AI services.
 *
 * Key Components:
 * 1. Semantic Analyzer - NLP-like text understanding
 * 2. Pattern Matcher - Learns from existing code patterns
 * 3. Rule Engine - Domain-specific intelligent decisions
 * 4. Context Analyzer - Understands test context and intent
 * 5. Method Generator - Creates intelligent method implementations
 */

import { CSReporter } from '../../reporter/CSReporter';
import { Action, CSCapability } from '../types';

export interface IntelligenceRequest {
    actions: Action[];
    elements: Array<{
        name: string;
        type: string;
        locator: string;
    }>;
    context: {
        pageName: string;
        url?: string;
        intent?: string;
    };
    capabilities: CSCapability[];
    projectPatterns?: any;
}

export interface IntelligentMethodSuggestion {
    methodName: string;
    parameters: Array<{ name: string; type: string; optional?: boolean }>;
    returnType: string;
    implementation: string;
    reasoning: string;
    confidence: number;
    frameworkMethodsUsed: string[];
}

export interface SemanticAnalysis {
    intent: string; // authentication, form-fill, navigation, crud, verification
    subIntent: string; // login, register, create, update, delete, search
    domainType: string; // ecommerce, banking, healthcare, admin, generic
    actionTypes: string[]; // fill, click, select, navigate, assert
    confidence: number;
    keywords: string[];
    entities: string[];
}

/**
 * Semantic Analyzer - Understands meaning without external AI
 */
export class SemanticAnalyzer {
    // Domain-specific keyword dictionaries
    private readonly domainKeywords = {
        authentication: [
            'login', 'signin', 'sign-in', 'log-in', 'auth', 'authenticate',
            'password', 'username', 'email', 'credentials', 'session',
            'logout', 'signout', 'sign-out', 'log-out', 'register', 'signup'
        ],
        ecommerce: [
            'cart', 'basket', 'checkout', 'payment', 'product', 'item',
            'purchase', 'buy', 'order', 'shipping', 'price', 'quantity',
            'add-to-cart', 'wishlist', 'inventory', 'catalog', 'browse'
        ],
        banking: [
            'account', 'balance', 'transfer', 'transaction', 'deposit',
            'withdrawal', 'funds', 'payment', 'bill', 'statement',
            'routing', 'swift', 'iban', 'wire', 'cheque', 'check'
        ],
        healthcare: [
            'patient', 'doctor', 'appointment', 'medical', 'prescription',
            'diagnosis', 'treatment', 'record', 'history', 'symptom',
            'clinic', 'hospital', 'pharmacy', 'medication', 'health'
        ],
        admin: [
            'user', 'role', 'permission', 'manage', 'edit', 'delete',
            'create', 'update', 'dashboard', 'settings', 'configuration',
            'admin', 'administrator', 'control-panel', 'system'
        ],
        form: [
            'form', 'input', 'field', 'submit', 'save', 'enter',
            'fill', 'select', 'choose', 'upload', 'attach', 'file'
        ]
    };

    private readonly intentKeywords = {
        authentication: ['login', 'signin', 'auth', 'password', 'username'],
        'form-fill': ['form', 'fill', 'enter', 'input', 'submit', 'save'],
        navigation: ['navigate', 'goto', 'visit', 'open', 'browse', 'menu'],
        crud: ['create', 'add', 'new', 'edit', 'update', 'delete', 'remove'],
        verification: ['verify', 'check', 'assert', 'validate', 'confirm', 'ensure'],
        search: ['search', 'find', 'filter', 'query', 'lookup']
    };

    /**
     * Analyze actions and understand intent using semantic analysis
     */
    public analyze(actions: Action[], context: string = ''): SemanticAnalysis {
        const text = this.extractTextFromActions(actions, context);
        const tokens = this.tokenize(text);
        const keywords = this.extractKeywords(tokens);
        const entities = this.extractEntities(text);

        // Detect domain
        const domainType = this.detectDomain(keywords);

        // Detect intent
        const { intent, subIntent } = this.detectIntent(actions, keywords);

        // Analyze action types
        const actionTypes = this.analyzeActionTypes(actions);

        // Calculate confidence
        const confidence = this.calculateConfidence(keywords, intent, domainType);

        return {
            intent,
            subIntent,
            domainType,
            actionTypes,
            confidence,
            keywords,
            entities
        };
    }

    private extractTextFromActions(actions: Action[], context: string): string {
        const parts = [context];

        for (const action of actions) {
            parts.push(action.expression);
            parts.push(action.method);
            parts.push(action.type);
            parts.push(...action.args.map(arg => String(arg)));
        }

        return parts.join(' ').toLowerCase();
    }

    private tokenize(text: string): string[] {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 2); // Filter out very short tokens
    }

    private extractKeywords(tokens: string[]): string[] {
        const keywords = new Set<string>();

        // Check against all domain dictionaries
        for (const domain of Object.values(this.domainKeywords)) {
            for (const keyword of domain) {
                if (tokens.includes(keyword) || tokens.some(t => t.includes(keyword))) {
                    keywords.add(keyword);
                }
            }
        }

        return Array.from(keywords);
    }

    private extractEntities(text: string): string[] {
        const entities: string[] = [];

        // Extract URLs
        const urlMatch = text.match(/https?:\/\/[^\s]+/g);
        if (urlMatch) entities.push(...urlMatch);

        // Extract email-like patterns
        const emailMatch = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi);
        if (emailMatch) entities.push(...emailMatch);

        // Extract common field names
        const fieldPatterns = ['username', 'password', 'email', 'phone', 'address', 'name'];
        for (const pattern of fieldPatterns) {
            if (text.includes(pattern)) {
                entities.push(pattern);
            }
        }

        return entities;
    }

    private detectDomain(keywords: string[]): string {
        const scores: Record<string, number> = {};

        // Score each domain based on keyword matches
        for (const [domain, domainKeywords] of Object.entries(this.domainKeywords)) {
            scores[domain] = 0;
            for (const keyword of keywords) {
                if (domainKeywords.includes(keyword)) {
                    scores[domain]++;
                }
            }
        }

        // Get highest scoring domain
        const entries = Object.entries(scores);
        if (entries.length === 0) return 'generic';

        entries.sort((a, b) => b[1] - a[1]);

        return entries[0][1] > 0 ? entries[0][0] : 'generic';
    }

    private detectIntent(actions: Action[], keywords: string[]): { intent: string; subIntent: string } {
        const actionTypes = new Set(actions.map(a => a.type));
        const scores: Record<string, number> = {};

        // Score intents based on keywords
        for (const [intent, intentKeywords] of Object.entries(this.intentKeywords)) {
            scores[intent] = 0;
            for (const keyword of keywords) {
                if (intentKeywords.includes(keyword)) {
                    scores[intent] += 2; // Keyword match
                }
            }
        }

        // Boost scores based on action patterns
        if (actionTypes.has('fill') && actionTypes.has('click')) {
            scores['form-fill'] = (scores['form-fill'] || 0) + 3;
        }

        if (actionTypes.has('navigation')) {
            scores['navigation'] = (scores['navigation'] || 0) + 3;
        }

        if (actions.some(a => a.type === 'assertion' || a.method.includes('assert'))) {
            scores['verification'] = (scores['verification'] || 0) + 3;
        }

        // Get highest scoring intent
        const entries = Object.entries(scores);
        entries.sort((a, b) => b[1] - a[1]);

        const intent = entries.length > 0 && entries[0][1] > 0 ? entries[0][0] : 'generic';
        const subIntent = this.detectSubIntent(intent, keywords, actions);

        return { intent, subIntent };
    }

    private detectSubIntent(intent: string, keywords: string[], actions: Action[]): string {
        // Sub-intent detection based on main intent
        switch (intent) {
            case 'authentication':
                if (keywords.some(k => ['login', 'signin'].includes(k))) return 'login';
                if (keywords.some(k => ['register', 'signup'].includes(k))) return 'register';
                if (keywords.some(k => ['logout', 'signout'].includes(k))) return 'logout';
                return 'login';

            case 'crud':
                if (keywords.some(k => ['create', 'add', 'new'].includes(k))) return 'create';
                if (keywords.some(k => ['edit', 'update', 'modify'].includes(k))) return 'update';
                if (keywords.some(k => ['delete', 'remove'].includes(k))) return 'delete';
                if (keywords.some(k => ['view', 'read', 'display'].includes(k))) return 'read';
                return 'create';

            case 'ecommerce':
                if (keywords.some(k => ['checkout', 'payment'].includes(k))) return 'checkout';
                if (keywords.some(k => ['cart', 'basket'].includes(k))) return 'add-to-cart';
                if (keywords.some(k => ['search', 'browse'].includes(k))) return 'browse';
                return 'browse';

            default:
                return 'standard';
        }
    }

    private analyzeActionTypes(actions: Action[]): string[] {
        return Array.from(new Set(actions.map(a => a.type)));
    }

    private calculateConfidence(keywords: string[], intent: string, domain: string): number {
        let confidence = 0.5; // Base confidence

        // More keywords = higher confidence
        if (keywords.length >= 5) confidence += 0.2;
        else if (keywords.length >= 3) confidence += 0.15;
        else if (keywords.length >= 1) confidence += 0.1;

        // Non-generic intent/domain = higher confidence
        if (intent !== 'generic') confidence += 0.1;
        if (domain !== 'generic') confidence += 0.1;

        return Math.min(confidence, 0.95); // Cap at 0.95
    }
}

/**
 * Pattern-Based Learning Engine
 * Learns from existing code WITHOUT external AI
 */
export class PatternLearningEngine {
    private patterns: Map<string, number> = new Map();
    private methodExamples: string[] = [];

    /**
     * Learn patterns from existing code
     */
    public learnFromCode(codeExamples: string[]): void {
        this.methodExamples = codeExamples;

        for (const code of codeExamples) {
            this.extractPatterns(code);
        }

        CSReporter.debug(`📚 Learned ${this.patterns.size} patterns from ${codeExamples.length} examples`);
    }

    private extractPatterns(code: string): void {
        // Extract common patterns
        const patterns = [
            { regex: /async\s+\w+\(/g, name: 'async-method' },
            { regex: /await\s+/g, name: 'uses-await' },
            { regex: /CSReporter\./g, name: 'uses-reporter' },
            { regex: /csAssert\./g, name: 'uses-assert' },
            { regex: /waitFor\w+\(/g, name: 'uses-wait' },
            { regex: /try\s*{[\s\S]*catch/g, name: 'uses-try-catch' },
            { regex: /\.fill\(/g, name: 'uses-fill' },
            { regex: /\.click\(/g, name: 'uses-click' },
            { regex: /\.select\(/g, name: 'uses-select' }
        ];

        for (const pattern of patterns) {
            const matches = code.match(pattern.regex);
            if (matches) {
                this.patterns.set(pattern.name, (this.patterns.get(pattern.name) || 0) + matches.length);
            }
        }
    }

    /**
     * Get pattern frequency
     */
    public getPatternFrequency(pattern: string): number {
        return this.patterns.get(pattern) || 0;
    }

    /**
     * Check if pattern is commonly used
     */
    public isCommonPattern(pattern: string, threshold: number = 0.5): boolean {
        const freq = this.getPatternFrequency(pattern);
        const total = this.methodExamples.length;
        return total > 0 && (freq / total) >= threshold;
    }

    /**
     * Get all learned patterns
     */
    public getPatterns(): Map<string, number> {
        return new Map(this.patterns);
    }
}

/**
 * Rule-Based Intelligence Engine
 * Makes intelligent decisions using rules (no external AI needed)
 */
export class RuleBasedIntelligence {
    /**
     * Generate intelligent method name
     */
    public generateMethodName(
        actionGroup: Action[],
        semanticAnalysis: SemanticAnalysis,
        context: string
    ): string {
        const actionTypes = new Set(actionGroup.map(a => a.type));

        // Rule 1: Form filling
        if (this.isFillAction(actionGroup)) {
            const entityName = this.extractEntityName(actionGroup, context);
            return `fill${this.toPascalCase(entityName)}`;
        }

        // Rule 2: Click action
        if (actionTypes.has('click') && actionGroup.length === 1) {
            const elementName = this.extractElementName(actionGroup[0]);
            return `click${this.toPascalCase(elementName)}`;
        }

        // Rule 3: Navigation
        if (actionTypes.has('navigation')) {
            return 'navigateToPage';
        }

        // Rule 4: Verification
        if (actionTypes.has('assertion')) {
            const what = this.extractVerificationTarget(actionGroup);
            return `verify${this.toPascalCase(what)}`;
        }

        // Rule 5: Select/dropdown
        if (actionTypes.has('select')) {
            const what = this.extractElementName(actionGroup[0]);
            return `select${this.toPascalCase(what)}`;
        }

        // Rule 6: Data extraction
        if (this.isDataExtraction(actionGroup)) {
            const what = this.extractElementName(actionGroup[0]);
            return `get${this.toPascalCase(what)}`;
        }

        // Default: based on semantic intent
        return this.generateIntentBasedName(semanticAnalysis);
    }

    /**
     * Generate method parameters
     */
    public generateParameters(
        actionGroup: Action[],
        elements: any[]
    ): Array<{ name: string; type: string; optional?: boolean }> {
        const params: Array<{ name: string; type: string; optional?: boolean }> = [];

        // Extract fill actions
        const fillActions = actionGroup.filter(a => a.type === 'fill' || a.type === 'type');

        if (fillActions.length > 0) {
            // Group related fills
            if (fillActions.length > 1) {
                // Multiple fills = likely a data object
                const entityName = this.extractEntityName(fillActions, '');
                params.push({
                    name: this.toCamelCase(entityName),
                    type: this.toPascalCase(entityName)
                });
            } else {
                // Single fill = single parameter
                const action = fillActions[0];
                const name = this.extractElementName(action);
                params.push({
                    name: this.toCamelCase(name),
                    type: 'string'
                });
            }
        }

        // Extract select actions
        const selectActions = actionGroup.filter(a => a.type === 'select');
        for (const action of selectActions) {
            const name = this.extractElementName(action);
            params.push({
                name: this.toCamelCase(name),
                type: 'string'
            });
        }

        return params;
    }

    private isFillAction(actions: Action[]): boolean {
        return actions.some(a => a.type === 'fill' || a.type === 'type');
    }

    private isDataExtraction(actions: Action[]): boolean {
        return actions.some(a =>
            a.method.includes('text') ||
            a.method.includes('value') ||
            a.method.includes('getAttribute')
        );
    }

    private extractEntityName(actions: Action[], context: string): string {
        const text = [context, ...actions.map(a => a.expression)].join(' ').toLowerCase();

        // Check for common entity patterns
        const entities = [
            'login', 'credentials', 'address', 'payment', 'shipping',
            'profile', 'account', 'details', 'information', 'form',
            'contact', 'personal', 'user', 'customer'
        ];

        for (const entity of entities) {
            if (text.includes(entity)) {
                return entity;
            }
        }

        return 'data';
    }

    private extractElementName(action: Action): string {
        const expr = action.expression.toLowerCase();

        // Extract from common patterns
        const patterns = [
            /click\s+["']([^"']+)["']/,
            /fill\s+["']([^"']+)["']/,
            /locator\(["']([^"']+)["']\)/,
            /getBy\w+\(["']([^"']+)["']\)/
        ];

        for (const pattern of patterns) {
            const match = expr.match(pattern);
            if (match) {
                return this.cleanName(match[1]);
            }
        }

        // Fallback: extract from action type
        return action.type;
    }

    private extractVerificationTarget(actions: Action[]): string {
        const assertAction = actions.find(a => a.type === 'assertion' || a.method.includes('assert'));
        if (assertAction) {
            return this.extractElementName(assertAction);
        }
        return 'result';
    }

    private generateIntentBasedName(analysis: SemanticAnalysis): string {
        return `${analysis.intent}${this.toPascalCase(analysis.subIntent)}`;
    }

    private cleanName(name: string): string {
        return name
            .replace(/[^a-zA-Z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .toLowerCase();
    }

    private toPascalCase(str: string): string {
        return str
            .split(/[\s-_]+/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('');
    }

    private toCamelCase(str: string): string {
        const pascal = this.toPascalCase(str);
        return pascal.charAt(0).toLowerCase() + pascal.slice(1);
    }
}

/**
 * Internal Intelligence Engine - Main orchestrator
 */
export class InternalIntelligenceEngine {
    private semanticAnalyzer: SemanticAnalyzer;
    private patternLearner: PatternLearningEngine;
    private ruleEngine: RuleBasedIntelligence;

    constructor() {
        this.semanticAnalyzer = new SemanticAnalyzer();
        this.patternLearner = new PatternLearningEngine();
        this.ruleEngine = new RuleBasedIntelligence();

        CSReporter.info('🧠 Internal Intelligence Engine initialized (No external AI dependencies)');
    }

    /**
     * Learn from existing project code
     */
    public learnFromProject(codeExamples: string[]): void {
        this.patternLearner.learnFromCode(codeExamples);
    }

    /**
     * Generate intelligent method suggestions
     */
    public generateMethods(request: IntelligenceRequest): IntelligentMethodSuggestion[] {
        CSReporter.info(`🧠 Generating intelligent methods using internal AI (${request.actions.length} actions)`);

        const suggestions: IntelligentMethodSuggestion[] = [];

        // Step 1: Semantic analysis
        const semantic = this.semanticAnalyzer.analyze(
            request.actions,
            `${request.context.pageName} ${request.context.url || ''} ${request.context.intent || ''}`
        );

        CSReporter.debug(`📊 Semantic Analysis: ${semantic.intent}/${semantic.subIntent} (${semantic.domainType}) - ${(semantic.confidence * 100).toFixed(0)}% confidence`);

        // Step 2: Group related actions
        const actionGroups = this.groupActions(request.actions, semantic);

        // Step 3: Generate method for each group
        for (const group of actionGroups) {
            const suggestion = this.generateMethodForGroup(
                group,
                semantic,
                request.elements,
                request.capabilities,
                request.context
            );

            if (suggestion) {
                suggestions.push(suggestion);
            }
        }

        CSReporter.pass(`✅ Generated ${suggestions.length} intelligent methods`);

        return suggestions;
    }

    /**
     * Analyze intent of test
     */
    public analyzeIntent(actions: Action[], context: string = ''): SemanticAnalysis {
        return this.semanticAnalyzer.analyze(actions, context);
    }

    /**
     * Generate intelligent page name
     */
    public generatePageName(url: string, actions: Action[]): string {
        const semantic = this.semanticAnalyzer.analyze(actions, url);

        // Extract from URL
        try {
            const urlObj = new URL(url);
            const path = urlObj.pathname;
            const parts = path.split('/').filter(p => p && !p.match(/^\d+$/));

            if (parts.length > 0) {
                const lastPart = parts[parts.length - 1]
                    .replace(/\.(php|jsp|html|aspx)$/, '');

                if (lastPart) {
                    return this.ruleEngine['toPascalCase'](lastPart) + 'Page';
                }
            }
        } catch {}

        // Fallback: use semantic analysis
        if (semantic.intent !== 'generic') {
            return this.ruleEngine['toPascalCase'](semantic.intent) + 'Page';
        }

        return 'Page';
    }

    /**
     * Group related actions into logical method boundaries
     */
    private groupActions(actions: Action[], semantic: SemanticAnalysis): Action[][] {
        const groups: Action[][] = [];
        let currentGroup: Action[] = [];

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];

            // Start new group on navigation
            if (action.type === 'navigation' && currentGroup.length > 0) {
                groups.push([...currentGroup]);
                currentGroup = [action];
                continue;
            }

            // Start new group on assertion
            if (action.type === 'assertion' && currentGroup.length > 0) {
                groups.push([...currentGroup]);
                currentGroup = [action];
                continue;
            }

            // Add to current group
            currentGroup.push(action);

            // Group boundary: action type change (fill → click)
            if (i < actions.length - 1) {
                const nextAction = actions[i + 1];
                if (this.isGroupBoundary(action, nextAction)) {
                    groups.push([...currentGroup]);
                    currentGroup = [];
                }
            }
        }

        // Add remaining actions
        if (currentGroup.length > 0) {
            groups.push(currentGroup);
        }

        return groups;
    }

    private isGroupBoundary(current: Action, next: Action): boolean {
        // Fill followed by click = boundary
        if ((current.type === 'fill' || current.type === 'type') && next.type === 'click') {
            return true;
        }

        // Click followed by fill = boundary
        if (current.type === 'click' && (next.type === 'fill' || next.type === 'type')) {
            return true;
        }

        return false;
    }

    private generateMethodForGroup(
        actionGroup: Action[],
        semantic: SemanticAnalysis,
        elements: any[],
        capabilities: CSCapability[],
        context: any
    ): IntelligentMethodSuggestion | null {
        // Generate method name using rule engine
        const methodName = this.ruleEngine.generateMethodName(
            actionGroup,
            semantic,
            context.pageName
        );

        // Generate parameters
        const parameters = this.ruleEngine.generateParameters(actionGroup, elements);

        // Generate implementation
        const implementation = this.generateImplementation(
            methodName,
            parameters,
            actionGroup,
            elements,
            capabilities
        );

        // Calculate confidence
        const confidence = this.calculateConfidence(actionGroup, semantic);

        return {
            methodName,
            parameters,
            returnType: 'Promise<void>',
            implementation,
            reasoning: this.generateReasoning(actionGroup, semantic),
            confidence,
            frameworkMethodsUsed: this.extractFrameworkMethods(actionGroup)
        };
    }

    private generateImplementation(
        methodName: string,
        parameters: any[],
        actions: Action[],
        elements: any[],
        capabilities: CSCapability[]
    ): string {
        const usesReporter = this.patternLearner.isCommonPattern('uses-reporter');
        const usesAssert = this.patternLearner.isCommonPattern('uses-assert');
        const usesWait = this.patternLearner.isCommonPattern('uses-wait');

        const paramStr = parameters.map(p => `${p.name}: ${p.type}`).join(', ');
        let impl = `async ${methodName}(${paramStr}): Promise<void> {\n`;

        // Add logging
        if (usesReporter) {
            const desc = methodName.replace(/([A-Z])/g, ' $1').trim().toLowerCase();
            impl += `    CSReporter.info('${desc}');\n\n`;
        }

        // Generate action code
        for (const action of actions) {
            const element = this.findElementForAction(action, elements);

            if (element) {
                // Add wait if pattern is common
                if (usesWait && (action.type === 'fill' || action.type === 'click')) {
                    impl += `    await this.${element.name}.waitForVisible();\n`;
                }

                // Add main action
                impl += `    await this.${element.name}.${this.selectFrameworkMethod(action, capabilities)};\n`;

                // Add assertion if common pattern
                if (usesAssert && action.type === 'click') {
                    impl += `    await csAssert.isVisible(this.${element.name});\n`;
                }

                impl += '\n';
            }
        }

        // Add success logging
        if (usesReporter) {
            impl += `    CSReporter.pass('${methodName} completed successfully');\n`;
        }

        impl += '}';

        return impl;
    }

    private findElementForAction(action: Action, elements: any[]): any {
        // Try to match by name
        const expr = action.expression.toLowerCase();
        for (const el of elements) {
            if (expr.includes(el.name.toLowerCase())) {
                return el;
            }
        }

        // Return first element as fallback
        return elements[0];
    }

    private selectFrameworkMethod(action: Action, capabilities: CSCapability[]): string {
        // Smart method selection based on action type
        switch (action.type) {
            case 'fill':
            case 'type':
                return 'fill(value)';
            case 'click':
                return 'click()';
            case 'select':
                return 'selectOption(option)';
            case 'check':
                return 'check()';
            default:
                return action.method + '()';
        }
    }

    private calculateConfidence(actions: Action[], semantic: SemanticAnalysis): number {
        let confidence = semantic.confidence;

        // Boost for well-formed action groups
        if (actions.length >= 2 && actions.length <= 5) {
            confidence += 0.1;
        }

        return Math.min(confidence, 0.95);
    }

    private generateReasoning(actions: Action[], semantic: SemanticAnalysis): string {
        const actionTypes = new Set(actions.map(a => a.type));

        if (actionTypes.has('fill') && actions.length > 1) {
            return `Grouped ${actions.length} fill actions into a single method for better reusability`;
        }

        if (actionTypes.has('click') && actions.length === 1) {
            return 'Single click action - created dedicated method for clarity';
        }

        if (actionTypes.has('assertion')) {
            return 'Verification action - created assertion method to validate state';
        }

        return `Generated based on ${semantic.intent} intent with ${(semantic.confidence * 100).toFixed(0)}% confidence`;
    }

    private extractFrameworkMethods(actions: Action[]): string[] {
        return Array.from(new Set(actions.map(a => a.method)));
    }
}
