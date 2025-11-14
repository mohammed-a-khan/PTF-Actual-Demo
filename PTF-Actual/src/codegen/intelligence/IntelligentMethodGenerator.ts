/**
 * Intelligent Method Generator
 *
 * This replaces ALL hardcoded method generation logic with intelligent,
 * context-aware generation that works for ANY domain.
 *
 * NO MORE HARDCODED LOGIN METHODS!
 */

import { Action, GeneratedMethod, GeneratedElement, TestIntent, CSCapability } from '../types';
import { FrameworkKnowledgeGraph } from '../knowledge/FrameworkKnowledgeGraph';
import { SuperIntelligentEngine, GeneratedMethodSuggestion, SuperIntelligenceRequest, SuperIntelligentMethodSuggestion } from './SuperIntelligentEngine';
import { CSReporter } from '../../reporter/CSReporter';

export interface MethodGenerationContext {
    actions: Action[];
    elements: GeneratedElement[];
    pageName: string;
    intent: TestIntent;
    url?: string;
    existingMethods?: GeneratedMethod[];
}

export interface ActionGroup {
    type: 'form-fill' | 'navigation' | 'verification' | 'interaction' | 'data-extraction';
    actions: Action[];
    primaryElement?: string;
    confidence: number;
}

export class IntelligentMethodGenerator {
    private knowledgeGraph: FrameworkKnowledgeGraph;
    private superAI: SuperIntelligentEngine;

    constructor() {
        this.knowledgeGraph = new FrameworkKnowledgeGraph();
        this.superAI = new SuperIntelligentEngine();
    }

    /**
     * Generate ALL methods for a page intelligently
     * NO HARDCODING - works for any domain
     */
    public async generateMethods(context: MethodGenerationContext): Promise<GeneratedMethod[]> {
        CSReporter.info(`🧠 Generating intelligent methods for ${context.pageName}...`);

        const methods: GeneratedMethod[] = [];

        try {
            // Step 1: Group related actions into logical methods
            const actionGroups = this.groupActions(context.actions, context.elements);
            CSReporter.debug(`📊 Grouped actions into ${actionGroups.length} logical methods`);

            // Step 2: Use SuperIntelligentEngine for ALL method generation
            methods.push(...this.generateWithSuperAI(actionGroups, context));

            // Step 3: Add helper methods (if needed)
            const helperMethods = this.generateHelperMethods(context);
            methods.push(...helperMethods);

            CSReporter.pass(`✅ Generated ${methods.length} intelligent methods`);

            return methods;
        } catch (error: any) {
            CSReporter.error(`❌ Method generation failed: ${error.message}`);
            // Return basic methods as fallback
            return this.generateBasicFallbackMethods(context);
        }
    }

    /**
     * Group actions into logical method boundaries
     */
    private groupActions(actions: Action[], elements: GeneratedElement[]): ActionGroup[] {
        const groups: ActionGroup[] = [];
        let currentGroup: Action[] = [];
        let groupType: ActionGroup['type'] = 'interaction';

        for (let i = 0; i < actions.length; i++) {
            const action = actions[i];
            const nextAction = actions[i + 1];

            currentGroup.push(action);

            // Determine if this is a boundary (should end current group)
            const isBoundary = this.isGroupBoundary(action, nextAction, currentGroup);

            if (isBoundary || i === actions.length - 1) {
                // Analyze group type
                const type = this.analyzeGroupType(currentGroup);
                const primaryElement = this.findPrimaryElement(currentGroup, elements);

                groups.push({
                    type,
                    actions: [...currentGroup],
                    primaryElement,
                    confidence: this.calculateGroupConfidence(currentGroup)
                });

                currentGroup = [];
            }
        }

        return groups.filter(g => g.actions.length > 0);
    }

    /**
     * Check if we should end the current action group
     */
    private isGroupBoundary(current: Action, next: Action | undefined, group: Action[]): boolean {
        if (!next) return true;

        // End group after navigation
        if (current.type === 'navigation') return true;

        // End group after assertion
        if (current.type === 'assertion' || current.type === 'expect') return true;

        // End group if action type changes significantly
        const currentIsInput = ['fill', 'type', 'select'].includes(current.type);
        const nextIsInput = ['fill', 'type', 'select'].includes(next.type);

        if (currentIsInput && !nextIsInput && group.length >= 2) {
            return true; // End form filling group
        }

        // End group if we have a click followed by non-click
        if (current.type === 'click' && next.type !== 'click' && group.length >= 1) {
            return true;
        }

        return false;
    }

    /**
     * Analyze what type of method this group represents
     */
    private analyzeGroupType(actions: Action[]): ActionGroup['type'] {
        const types = actions.map(a => a.type);
        const fillCount = types.filter(t => t === 'fill' || t === 'type').length;
        const clickCount = types.filter(t => t === 'click').length;
        const selectCount = types.filter(t => t === 'select').length;
        const assertCount = types.filter(t => t === 'assertion' || t === 'expect').length;
        const navCount = types.filter(t => t === 'navigation').length;

        // Form fill: Multiple fills + maybe a submit
        if (fillCount >= 2 || (fillCount >= 1 && selectCount >= 1)) {
            return 'form-fill';
        }

        // Navigation: Goto or click followed by navigation
        if (navCount > 0) {
            return 'navigation';
        }

        // Verification: Assertions/expects
        if (assertCount > 0) {
            return 'verification';
        }

        // Data extraction: Getting text/attributes
        const hasGetter = actions.some(a =>
            a.method.includes('text') ||
            a.method.includes('value') ||
            a.method.includes('attribute')
        );
        if (hasGetter) {
            return 'data-extraction';
        }

        // Default: Generic interaction
        return 'interaction';
    }

    /**
     * Find the primary element for this action group
     */
    private findPrimaryElement(actions: Action[], elements: GeneratedElement[]): string | undefined {
        // Look for submit button, primary input, etc.
        for (const action of actions.reverse()) {
            if (action.type === 'click') {
                const expr = action.expression.toLowerCase();
                if (expr.includes('submit') || expr.includes('save') || expr.includes('button')) {
                    return this.matchActionToElement(action, elements);
                }
            }
        }

        // Return first relevant element
        if (actions.length > 0) {
            return this.matchActionToElement(actions[0], elements);
        }

        return undefined;
    }

    /**
     * Match action to element name
     */
    private matchActionToElement(action: Action, elements: GeneratedElement[]): string | undefined {
        const expr = action.expression.toLowerCase();

        for (const element of elements) {
            if (expr.includes(element.name.toLowerCase())) {
                return element.name;
            }
        }

        return undefined;
    }

    /**
     * Calculate confidence in group detection
     */
    private calculateGroupConfidence(actions: Action[]): number {
        // More actions = higher confidence
        // Clear patterns = higher confidence
        let confidence = Math.min(0.5 + (actions.length * 0.1), 1.0);
        return confidence;
    }

    /**
     * Generate methods using SuperIntelligentEngine (100% INTERNAL AI)
     */
    private generateWithSuperAI(
        groups: ActionGroup[],
        context: MethodGenerationContext
    ): GeneratedMethod[] {
        CSReporter.info('🧠 Using SUPER INTELLIGENT ENGINE for method generation...');

        // If very few actions, use heuristics (faster and more reliable)
        if (context.actions.length <= 1) {
            CSReporter.debug('📊 Small action set detected, using heuristics for speed');
            return this.generateWithHeuristics(groups, context);
        }

        const capabilities = this.knowledgeGraph.getAllCapabilities();

        try {
            const request: SuperIntelligenceRequest = {
                actions: context.actions,
                elements: context.elements.map(e => ({
                    name: e.name,
                    type: e.type,
                    locator: e.locator
                })),
                context: {
                    pageName: context.pageName,
                    url: context.url,
                    intent: context.intent.type
                },
                capabilities,
                existingMethods: context.existingMethods?.map(m => m.name) || []
            };

            const suggestions = this.superAI.generateMethods(request);
            return suggestions.map(suggestion => this.convertSuperAISuggestion(suggestion));
        } catch (error: any) {
            CSReporter.warn(`⚠️ Super AI generation encountered issue, using fallback: ${error.message}`);
            return this.generateWithHeuristics(groups, context);
        }
    }

    /**
     * Convert SuperIntelligentEngine suggestion to GeneratedMethod
     */
    private convertSuperAISuggestion(suggestion: SuperIntelligentMethodSuggestion): GeneratedMethod {
        return {
            name: suggestion.methodName,
            returnType: suggestion.returnType,
            parameters: suggestion.parameters.map(p => ({
                name: p.name,
                type: p.type,
                optional: p.optional
            })),
            implementation: suggestion.implementation,
            comment: `/**\n * ${suggestion.reasoning}\n * Confidence: ${(suggestion.confidence * 100).toFixed(0)}%\n * Framework methods: ${suggestion.frameworkMethodsUsed.join(', ')}\n * Best practices: ${suggestion.bestPractices?.join(', ') || 'N/A'}\n */`,
            isAsync: true
        };
    }

    /**
     * Generate methods using intelligent heuristics (FALLBACK)
     */
    private generateWithHeuristics(
        groups: ActionGroup[],
        context: MethodGenerationContext
    ): GeneratedMethod[] {
        CSReporter.info('🔧 Using intelligent heuristics for method generation...');

        const methods: GeneratedMethod[] = [];

        for (const group of groups) {
            let method: GeneratedMethod | null = null;

            switch (group.type) {
                case 'form-fill':
                    method = this.generateFormFillMethod(group, context);
                    break;
                case 'navigation':
                    method = this.generateNavigationMethod(group, context);
                    break;
                case 'verification':
                    method = this.generateVerificationMethod(group, context);
                    break;
                case 'interaction':
                    method = this.generateInteractionMethod(group, context);
                    break;
                case 'data-extraction':
                    method = this.generateDataExtractionMethod(group, context);
                    break;
            }

            if (method) {
                methods.push(method);
            }
        }

        return methods;
    }

    /**
     * Generate form fill method (GENERIC - not just login!)
     */
    private generateFormFillMethod(group: ActionGroup, context: MethodGenerationContext): GeneratedMethod {
        const fillActions = group.actions.filter(a => a.type === 'fill' || a.type === 'type' || a.type === 'select');
        const submitAction = group.actions.find(a => a.type === 'click');

        // Extract parameter names from actions
        const parameters = fillActions.map(action => {
            const elementName = this.matchActionToElement(action, context.elements) || 'value';
            return {
                name: this.toCamelCase(elementName),
                type: 'string',
                optional: false
            };
        });

        // Generate method name based on primary element or action
        const methodName = group.primaryElement
            ? `fill${this.toPascalCase(group.primaryElement)}Form`
            : `fillForm`;

        // Build implementation
        const impl = this.buildFormFillImplementation(group, context, parameters);

        return {
            name: methodName,
            returnType: 'Promise<void>',
            parameters,
            implementation: impl,
            comment: `/**\n * Fill form fields\n * Generated from ${fillActions.length} fill actions\n */`,
            isAsync: true
        };
    }

    /**
     * Build form fill implementation with intelligent framework method selection
     */
    private buildFormFillImplementation(
        group: ActionGroup,
        context: MethodGenerationContext,
        parameters: any[]
    ): string {
        const lines: string[] = [];

        lines.push(`async ${group.primaryElement ? 'fill' + this.toPascalCase(group.primaryElement) + 'Form' : 'fillForm'}(`);
        lines.push(`    ${parameters.map(p => `${p.name}: ${p.type}`).join(', ')}`);
        lines.push(`): Promise<void> {`);
        lines.push(`    CSReporter.info('Filling form...');`);
        lines.push(``);

        let paramIndex = 0;
        for (const action of group.actions) {
            const elementName = this.matchActionToElement(action, context.elements);

            if (action.type === 'fill' || action.type === 'type') {
                const param = parameters[paramIndex]?.name || 'value';

                lines.push(`    // Enter ${elementName}`);
                lines.push(`    await this.${elementName}.waitForVisible(5000);`);

                // Select best fill method based on context
                const fillMethod = this.selectBestFillMethod(action);
                lines.push(`    await this.${elementName}.${fillMethod}(${param});`);

                lines.push(`    CSReporter.debug('${elementName} entered');`);
                lines.push(``);

                paramIndex++;
            } else if (action.type === 'select') {
                const param = parameters[paramIndex]?.name || 'value';

                lines.push(`    // Select ${elementName}`);
                lines.push(`    await this.${elementName}.selectOptionByLabel(${param});`);
                lines.push(`    CSReporter.debug('${elementName} selected');`);
                lines.push(``);

                paramIndex++;
            } else if (action.type === 'click') {
                lines.push(`    // Submit form`);
                lines.push(`    await this.${elementName}.waitForEnabled();`);
                lines.push(`    await this.${elementName}.click();`);
                lines.push(`    CSReporter.pass('Form submitted successfully');`);
            }
        }

        lines.push(`}`);

        return lines.join('\n');
    }

    /**
     * Select best fill method based on action context
     */
    private selectBestFillMethod(action: Action): string {
        // Check for force option
        if (action.options.force) {
            return 'fillWithForce';
        }

        // Check for timeout
        if (action.options.timeout && action.options.timeout > 5000) {
            return `fillWithTimeout`;
        }

        // Check for delay (autocomplete fields)
        if (action.options.delay) {
            return 'pressSequentially';
        }

        // Default
        return 'fill';
    }

    /**
     * Generate navigation method
     */
    private generateNavigationMethod(group: ActionGroup, context: MethodGenerationContext): GeneratedMethod {
        const navAction = group.actions.find(a => a.type === 'navigation');
        const clickAction = group.actions.find(a => a.type === 'click');

        const methodName = clickAction
            ? `clickAndNavigate`
            : `navigateToPage`;

        const impl = this.buildNavigationImplementation(group, context);

        return {
            name: methodName,
            returnType: 'Promise<void>',
            parameters: navAction?.args[0] ? [{ name: 'url', type: 'string', optional: true }] : [],
            implementation: impl,
            comment: `/**\n * Navigate to page\n */`,
            isAsync: true
        };
    }

    private buildNavigationImplementation(group: ActionGroup, context: MethodGenerationContext): string {
        const lines: string[] = [];
        const navAction = group.actions.find(a => a.type === 'navigation');
        const clickAction = group.actions.find(a => a.type === 'click');

        const methodName = clickAction ? 'clickAndNavigate' : 'navigateToPage';
        const params = navAction?.args[0] ? 'url?: string' : '';

        lines.push(`async ${methodName}(${params}): Promise<void> {`);

        if (clickAction) {
            const elementName = this.matchActionToElement(clickAction, context.elements) || 'element';
            lines.push(`    CSReporter.info('Clicking navigation element');`);
            lines.push(`    await this.${elementName}.click();`);
        }

        if (navAction) {
            lines.push(`    CSReporter.info('Navigating to page...');`);
            lines.push(`    await this.navigate(url || '${navAction.args[0]}');`);
        }

        lines.push(`    await this.waitForPageLoad();`);
        lines.push(`    CSReporter.pass('Navigation completed');`);
        lines.push(`}`);

        return lines.join('\n');
    }

    /**
     * Generate verification method
     */
    private generateVerificationMethod(group: ActionGroup, context: MethodGenerationContext): GeneratedMethod {
        const impl = this.buildVerificationImplementation(group, context);

        return {
            name: 'verifyPageElements',
            returnType: 'Promise<void>',
            parameters: [],
            implementation: impl,
            comment: `/**\n * Verify page elements and state\n */`,
            isAsync: true
        };
    }

    private buildVerificationImplementation(group: ActionGroup, context: MethodGenerationContext): string {
        const lines: string[] = [];

        lines.push(`async verifyPageElements(): Promise<void> {`);
        lines.push(`    CSReporter.info('Verifying page elements...');`);
        lines.push(``);

        for (const action of group.actions) {
            const elementName = this.matchActionToElement(action, context.elements) || 'element';

            if (action.method.includes('toBeVisible') || action.method.includes('visible')) {
                lines.push(`    await csExpect.toBeVisible(this.${elementName});`);
            } else if (action.method.includes('toHaveText')) {
                const expectedText = action.args[0] || 'expected text';
                lines.push(`    await csExpect.toHaveText(this.${elementName}, '${expectedText}');`);
            }
        }

        lines.push(``);
        lines.push(`    CSReporter.pass('All verifications passed');`);
        lines.push(`}`);

        return lines.join('\n');
    }

    /**
     * Generate generic interaction method
     */
    private generateInteractionMethod(group: ActionGroup, context: MethodGenerationContext): GeneratedMethod {
        const primaryAction = group.actions[0];
        const elementName = this.matchActionToElement(primaryAction, context.elements) || 'element';

        const methodName = `${primaryAction.type}${this.toPascalCase(elementName)}`;
        const impl = this.buildInteractionImplementation(group, context);

        return {
            name: methodName,
            returnType: 'Promise<void>',
            parameters: [],
            implementation: impl,
            comment: `/**\n * Perform interaction\n */`,
            isAsync: true
        };
    }

    private buildInteractionImplementation(group: ActionGroup, context: MethodGenerationContext): string {
        const primaryAction = group.actions[0];
        const elementName = this.matchActionToElement(primaryAction, context.elements) || 'element';
        const methodName = `${primaryAction.type}${this.toPascalCase(elementName)}`;

        const lines: string[] = [];
        lines.push(`async ${methodName}(): Promise<void> {`);
        lines.push(`    CSReporter.info('Performing interaction...');`);
        lines.push(`    await this.${elementName}.${this.selectBestMethod(primaryAction)}();`);
        lines.push(`    CSReporter.pass('Interaction completed');`);
        lines.push(`}`);

        return lines.join('\n');
    }

    private selectBestMethod(action: Action): string {
        // Use knowledge graph to find best method
        const match = this.knowledgeGraph.findBestCapability(action);
        return match.capability.name;
    }

    /**
     * Generate data extraction method
     */
    private generateDataExtractionMethod(group: ActionGroup, context: MethodGenerationContext): GeneratedMethod {
        return {
            name: 'extractData',
            returnType: 'Promise<Record<string, string>>',
            parameters: [],
            implementation: `async extractData(): Promise<Record<string, string>> {
    CSReporter.info('Extracting data from page...');

    const data: Record<string, string> = {};

    // Add extraction logic here

    CSReporter.pass(\`Extracted \${Object.keys(data).length} data points\`);
    return data;
}`,
            comment: `/**\n * Extract data from page elements\n */`,
            isAsync: true
        };
    }

    /**
     * Generate helper methods (waitForLoad, etc.)
     */
    private generateHelperMethods(context: MethodGenerationContext): GeneratedMethod[] {
        // For now, return empty - base page has these
        return [];
    }

    /**
     * Generate basic fallback methods if all else fails
     */
    private generateBasicFallbackMethods(context: MethodGenerationContext): GeneratedMethod[] {
        CSReporter.warn('⚠️ Using basic fallback method generation');

        return [{
            name: 'performActions',
            returnType: 'Promise<void>',
            parameters: [],
            implementation: `async performActions(): Promise<void> {
    // TODO: Implement actions
    CSReporter.info('Performing actions...');
}`,
            comment: `/**\n * Perform page actions\n */`,
            isAsync: true
        }];
    }

    // ===== UTILITY METHODS =====

    private toPascalCase(str: string): string {
        return str
            .split(/[\s_-]+/)
            .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join('');
    }

    private toCamelCase(str: string): string {
        const pascal = this.toPascalCase(str);
        return pascal.charAt(0).toLowerCase() + pascal.slice(1);
    }
}
