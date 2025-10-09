/**
 * Pattern Learner - Learns new UI patterns from successful identifications
 * Discovers recurring element patterns to improve future identifications
 */

import { CSReporter } from '../../reporter/CSReporter';
import { CSPatternMatcher } from '../patterns/CSPatternMatcher';
import { CSAIHistory } from './CSAIHistory';
import {
    UIPattern,
    ElementFeatures,
    AIHistoryEntry
} from '../types/AITypes';

interface LearnedPattern {
    pattern: UIPattern;
    occurrences: number;
    successRate: number;
    firstSeen: Date;
    lastSeen: Date;
    confidence: number;
}

export class CSPatternLearner {
    private static instance: CSPatternLearner;
    private learnedPatterns: Map<string, LearnedPattern> = new Map();
    private patternMatcher: CSPatternMatcher;
    private aiHistory: CSAIHistory;
    private learningEnabled: boolean = true;
    private minOccurrences: number = 3; // Minimum occurrences before considering as pattern
    private minConfidence: number = 0.7; // Minimum confidence threshold

    private constructor() {
        this.patternMatcher = CSPatternMatcher.getInstance();
        this.aiHistory = CSAIHistory.getInstance();
        CSReporter.debug('[CSPatternLearner] Initialized');
    }

    public static getInstance(): CSPatternLearner {
        if (!CSPatternLearner.instance) {
            CSPatternLearner.instance = new CSPatternLearner();
        }
        return CSPatternLearner.instance;
    }

    /**
     * Learn from successful element identification
     */
    public learnFromIdentification(
        features: ElementFeatures,
        locator: string,
        success: boolean,
        confidence: number
    ): void {
        if (!this.learningEnabled) return;
        if (!success || confidence < this.minConfidence) return;

        try {
            CSReporter.debug(`[PatternLearner] Learning from identification: ${locator}`);

            // Extract pattern characteristics
            const patternKey = this.generatePatternKey(features);
            const pattern = this.extractPattern(features, locator);

            if (!this.learnedPatterns.has(patternKey)) {
                // New pattern discovered
                this.learnedPatterns.set(patternKey, {
                    pattern,
                    occurrences: 1,
                    successRate: 1.0,
                    firstSeen: new Date(),
                    lastSeen: new Date(),
                    confidence
                });

                CSReporter.debug(`[PatternLearner] New pattern discovered: ${pattern.name}`);
            } else {
                // Update existing pattern
                const learned = this.learnedPatterns.get(patternKey)!;
                learned.occurrences++;
                learned.lastSeen = new Date();
                learned.confidence = (learned.confidence + confidence) / 2; // Running average

                // Check if pattern should be registered
                if (learned.occurrences >= this.minOccurrences && learned.confidence >= this.minConfidence) {
                    this.registerLearnedPattern(learned);
                }
            }
        } catch (error) {
            CSReporter.debug(`[PatternLearner] Error learning pattern: ${error}`);
        }
    }

    /**
     * Extract pattern from element features
     */
    private extractPattern(features: ElementFeatures, locator: string): UIPattern {
        const name = this.generatePatternName(features);
        const description = this.generatePatternDescription(features);
        const selectors = this.generatePatternSelectors(features, locator);
        const tags = this.generatePatternTags(features);
        const attributes = this.generatePatternAttributes(features);

        return {
            name,
            description,
            selectors,
            attributes,
            tags,
            confidence: 0.75, // Initial confidence for learned patterns
            weight: 0.8 // Slightly lower weight than built-in patterns
        };
    }

    /**
     * Generate pattern key for deduplication
     */
    private generatePatternKey(features: ElementFeatures): string {
        const components = [
            features.structural.tagName,
            features.semantic.role || 'no-role',
            features.semantic.semanticType,
            features.structural.inputType || 'no-input-type'
        ];

        // Add distinctive classes (non-generic ones)
        const distinctiveClasses = features.structural.classList
            .filter(c => !this.isGenericClass(c))
            .sort()
            .slice(0, 2);

        return [...components, ...distinctiveClasses].join('__');
    }

    /**
     * Generate pattern name
     */
    private generatePatternName(features: ElementFeatures): string {
        const role = features.semantic.role || features.structural.tagName;
        const type = features.structural.inputType;
        const semanticType = features.semantic.semanticType;

        if (type) {
            return `${role}_${type}`.replace(/[^a-zA-Z0-9_]/g, '_');
        }

        if (semanticType && semanticType !== 'generic') {
            return `${semanticType}_${role}`.replace(/[^a-zA-Z0-9_]/g, '_');
        }

        return `learned_${role}`.replace(/[^a-zA-Z0-9_]/g, '_');
    }

    /**
     * Generate pattern description
     */
    private generatePatternDescription(features: ElementFeatures): string {
        const role = features.semantic.role || features.structural.tagName;
        const type = features.structural.inputType;

        if (type) {
            return `Learned pattern for ${role} element with type ${type}`;
        }

        return `Learned pattern for ${role} element`;
    }

    /**
     * Generate pattern selectors
     */
    private generatePatternSelectors(features: ElementFeatures, originalLocator: string): string[] {
        const selectors: string[] = [];

        // Original locator
        selectors.push(originalLocator);

        // Role-based selector
        if (features.semantic.role) {
            selectors.push(`[role="${features.semantic.role}"]`);
        }

        // Tag with attributes
        const tag = features.structural.tagName;

        if (features.structural.inputType) {
            selectors.push(`${tag}[type="${features.structural.inputType}"]`);
        }

        // ARIA label selector
        if (features.text.ariaLabel) {
            selectors.push(`[aria-label="${features.text.ariaLabel}"]`);
        }

        // Class-based selectors (non-generic classes only)
        const distinctiveClasses = features.structural.classList
            .filter(c => !this.isGenericClass(c))
            .slice(0, 2);

        if (distinctiveClasses.length > 0) {
            selectors.push(`.${distinctiveClasses.join('.')}`);
        }

        // Data attribute selectors
        const dataAttrs = Object.entries(features.structural.attributes)
            .filter(([key]) => key.startsWith('data-'))
            .slice(0, 2);

        dataAttrs.forEach(([key, value]) => {
            selectors.push(`[${key}="${value}"]`);
        });

        return selectors;
    }

    /**
     * Generate pattern tags
     */
    private generatePatternTags(features: ElementFeatures): string[] {
        const tags: string[] = [];

        tags.push(features.structural.tagName);

        if (features.semantic.role) {
            tags.push(features.semantic.role);
        }

        if (features.semantic.semanticType && features.semantic.semanticType !== 'generic') {
            tags.push(features.semantic.semanticType);
        }

        if (features.structural.inputType) {
            tags.push(features.structural.inputType);
        }

        if (features.structural.formElement) {
            tags.push('form');
        }

        if (features.semantic.isLandmark) {
            tags.push('landmark');
        }

        return tags;
    }

    /**
     * Generate pattern attributes
     */
    private generatePatternAttributes(features: ElementFeatures): Record<string, string> {
        const attributes: Record<string, string> = {
            type: features.structural.tagName
        };

        if (features.structural.formElement) {
            attributes.form_element = 'true';
        }

        if (features.structural.isInteractive) {
            attributes.interactive = 'true';
        }

        if (features.semantic.isLandmark) {
            attributes.landmark = 'true';
        }

        if (features.structural.inputType) {
            attributes.input_type = features.structural.inputType;
        }

        return attributes;
    }

    /**
     * Register learned pattern with pattern matcher
     */
    private registerLearnedPattern(learned: LearnedPattern): void {
        try {
            // Check if already registered
            const existing = this.patternMatcher.getPattern(learned.pattern.name);

            if (existing) {
                CSReporter.debug(`[PatternLearner] Pattern ${learned.pattern.name} already registered`);
                return;
            }

            // Register with pattern matcher
            this.patternMatcher.registerPattern(learned.pattern);

            CSReporter.debug(`[PatternLearner] Registered learned pattern: ${learned.pattern.name} (${learned.occurrences} occurrences, ${(learned.confidence * 100).toFixed(1)}% confidence)`);
        } catch (error) {
            CSReporter.debug(`[PatternLearner] Error registering pattern: ${error}`);
        }
    }

    /**
     * Analyze history to learn patterns
     */
    public analyzeHistory(): void {
        if (!this.learningEnabled) return;

        CSReporter.debug('[PatternLearner] Analyzing history for patterns');

        const successful = this.aiHistory.getByOperation('identification')
            .filter(entry => entry.success && entry.confidence && entry.confidence >= this.minConfidence);

        CSReporter.debug(`[PatternLearner] Found ${successful.length} successful identifications to analyze`);

        // Group similar identifications
        const groups = this.groupSimilarIdentifications(successful);

        groups.forEach((group, key) => {
            if (group.length >= this.minOccurrences) {
                CSReporter.debug(`[PatternLearner] Found recurring pattern: ${key} (${group.length} occurrences)`);
                // Could learn from this group
            }
        });
    }

    /**
     * Group similar identifications
     */
    private groupSimilarIdentifications(entries: AIHistoryEntry[]): Map<string, AIHistoryEntry[]> {
        const groups = new Map<string, AIHistoryEntry[]>();

        entries.forEach(entry => {
            // Group by element description similarity
            const key = this.normalizeDescription(entry.elementDescription);

            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key)!.push(entry);
        });

        return groups;
    }

    /**
     * Normalize description for grouping
     */
    private normalizeDescription(description: string): string {
        return description
            .toLowerCase()
            .replace(/\d+/g, 'N') // Replace numbers with N
            .replace(/["']/g, '')  // Remove quotes
            .trim();
    }

    /**
     * Check if class name is generic
     */
    private isGenericClass(className: string): boolean {
        const generic = [
            'btn', 'button', 'input', 'form', 'container', 'wrapper', 'content',
            'active', 'hidden', 'visible', 'show', 'hide', 'disabled', 'enabled',
            'col', 'row', 'grid', 'flex', 'center', 'left', 'right'
        ];

        return generic.some(g => className.toLowerCase().includes(g));
    }

    /**
     * Get learned patterns
     */
    public getLearnedPatterns(): LearnedPattern[] {
        return Array.from(this.learnedPatterns.values())
            .sort((a, b) => b.occurrences - a.occurrences);
    }

    /**
     * Get patterns by confidence threshold
     */
    public getPatternsByConfidence(minConfidence: number): LearnedPattern[] {
        return Array.from(this.learnedPatterns.values())
            .filter(p => p.confidence >= minConfidence)
            .sort((a, b) => b.confidence - a.confidence);
    }

    /**
     * Get most frequent patterns
     */
    public getMostFrequentPatterns(count: number = 10): LearnedPattern[] {
        return this.getLearnedPatterns().slice(0, count);
    }

    /**
     * Get pattern by name
     */
    public getPattern(name: string): LearnedPattern | undefined {
        for (const [key, pattern] of this.learnedPatterns) {
            if (pattern.pattern.name === name) {
                return pattern;
            }
        }
        return undefined;
    }

    /**
     * Remove learned pattern
     */
    public removePattern(name: string): boolean {
        for (const [key, pattern] of this.learnedPatterns) {
            if (pattern.pattern.name === name) {
                this.learnedPatterns.delete(key);
                this.patternMatcher.removePattern(name);
                CSReporter.debug(`[PatternLearner] Removed pattern: ${name}`);
                return true;
            }
        }
        return false;
    }

    /**
     * Clear all learned patterns
     */
    public clearPatterns(): void {
        // Unregister from pattern matcher
        this.learnedPatterns.forEach(learned => {
            this.patternMatcher.removePattern(learned.pattern.name);
        });

        this.learnedPatterns.clear();
        CSReporter.debug('[PatternLearner] Cleared all learned patterns');
    }

    /**
     * Enable/disable learning
     */
    public setLearningEnabled(enabled: boolean): void {
        this.learningEnabled = enabled;
        CSReporter.debug(`[PatternLearner] Learning ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Set minimum occurrences threshold
     */
    public setMinOccurrences(min: number): void {
        this.minOccurrences = Math.max(1, min);
        CSReporter.debug(`[PatternLearner] Minimum occurrences set to ${this.minOccurrences}`);
    }

    /**
     * Set minimum confidence threshold
     */
    public setMinConfidence(min: number): void {
        this.minConfidence = Math.max(0, Math.min(1, min));
        CSReporter.debug(`[PatternLearner] Minimum confidence set to ${this.minConfidence}`);
    }

    /**
     * Get learning statistics
     */
    public getStatistics(): {
        totalPatternsLearned: number;
        registeredPatterns: number;
        averageOccurrences: number;
        averageConfidence: number;
        mostFrequentPattern: string | null;
        learningEnabled: boolean;
        minOccurrences: number;
        minConfidence: number;
    } {
        const patterns = this.getLearnedPatterns();
        const registered = patterns.filter(p => p.occurrences >= this.minOccurrences);

        const totalOccurrences = patterns.reduce((sum, p) => sum + p.occurrences, 0);
        const totalConfidence = patterns.reduce((sum, p) => sum + p.confidence, 0);

        const mostFrequent = patterns.length > 0 ? patterns[0].pattern.name : null;

        return {
            totalPatternsLearned: patterns.length,
            registeredPatterns: registered.length,
            averageOccurrences: patterns.length > 0 ? totalOccurrences / patterns.length : 0,
            averageConfidence: patterns.length > 0 ? totalConfidence / patterns.length : 0,
            mostFrequentPattern: mostFrequent,
            learningEnabled: this.learningEnabled,
            minOccurrences: this.minOccurrences,
            minConfidence: this.minConfidence
        };
    }

    /**
     * Export learned patterns
     */
    public export() {
        return {
            patterns: this.getLearnedPatterns(),
            statistics: this.getStatistics()
        };
    }

    /**
     * Import learned patterns
     */
    public import(data: { patterns: LearnedPattern[] }): void {
        data.patterns.forEach(learned => {
            const key = this.generatePatternKey({
                text: {} as any,
                visual: {} as any,
                structural: {
                    tagName: learned.pattern.attributes.type || 'unknown',
                    classList: [],
                    inputType: learned.pattern.attributes.input_type
                } as any,
                semantic: {
                    role: learned.pattern.tags[0] || 'generic',
                    semanticType: learned.pattern.tags[1] || 'generic'
                } as any,
                context: {} as any,
                timestamp: Date.now()
            });

            this.learnedPatterns.set(key, learned);

            if (learned.occurrences >= this.minOccurrences) {
                this.registerLearnedPattern(learned);
            }
        });

        CSReporter.debug(`[PatternLearner] Imported ${data.patterns.length} learned patterns`);
    }
}
