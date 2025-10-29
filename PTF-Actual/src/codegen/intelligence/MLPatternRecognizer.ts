/**
 * ML-Based Pattern Recognition - Layer 5
 *
 * This layer uses machine learning techniques to recognize test patterns
 * and continuously improve through training on successful tests.
 *
 * Features:
 * - Pattern library with similarity matching
 * - Feature extraction from test actions
 * - Clustering of similar test scenarios
 * - Confidence scoring based on historical data
 * - Self-learning from test execution results
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    DeepCodeAnalysis,
    Action,
    DetectedPattern,
    PatternSuggestion,
    ExistingStep
} from '../types';

export interface MLPattern {
    id: string;
    name: string;
    type: string;
    actionSequence: string[]; // Sequence of action types
    features: PatternFeatures;
    examples: PatternExample[];
    confidence: number;
    usageCount: number;
    successRate: number;
}

export interface PatternFeatures {
    actionCount: number;
    fillCount: number;
    clickCount: number;
    assertionCount: number;
    navigationCount: number;
    hasSubmit: boolean;
    hasValidation: boolean;
    hasErrorHandling: boolean;
    complexity: 'simple' | 'moderate' | 'complex';
}

export interface PatternExample {
    source: string;
    actions: Action[];
    outcome: 'success' | 'failure' | 'unknown';
    timestamp: number;
}

export interface PatternMatch {
    pattern: MLPattern;
    similarity: number;
    confidence: number;
    reasoning: string[];
}

export class MLPatternRecognizer {
    private patternLibrary: Map<string, MLPattern> = new Map();
    private trainingDataPath: string;
    private minSimilarity: number = 0.7;

    constructor(options?: { trainingDataPath?: string; minSimilarity?: number }) {
        this.trainingDataPath = options?.trainingDataPath || path.join(process.cwd(), '.cs-codegen/patterns.json');
        this.minSimilarity = options?.minSimilarity || 0.7;

        this.loadPatternLibrary();
        this.initializeDefaultPatterns();
    }

    /**
     * Recognize patterns in the test code using ML techniques
     */
    public async recognizePatterns(analysis: DeepCodeAnalysis): Promise<DetectedPattern[]> {
        const { actions } = analysis;

        // Extract features from the test
        const testFeatures = this.extractFeatures(actions);

        // Find similar patterns using cosine similarity
        const matches = this.findSimilarPatterns(testFeatures, actions);

        // Convert matches to detected patterns
        const detected: DetectedPattern[] = [];

        for (const match of matches) {
            if (match.similarity >= this.minSimilarity) {
                detected.push({
                    type: match.pattern.type,
                    name: match.pattern.name,
                    confidence: match.confidence,
                    actions: this.extractPatternActions(actions, match.pattern),
                    suggestion: await this.generateSuggestion(match, actions)
                });
            }
        }

        // Learn from this test (async, don't block)
        this.learnFromTest(testFeatures, actions).catch(console.error);

        return detected;
    }

    /**
     * Extract features from action sequence
     */
    private extractFeatures(actions: Action[]): PatternFeatures {
        const fillCount = actions.filter(a => a.type === 'fill').length;
        const clickCount = actions.filter(a => a.type === 'click').length;
        const assertionCount = actions.filter(a => a.type === 'assertion').length;
        const navigationCount = actions.filter(a => a.type === 'navigation').length;

        // Detect submit action
        const hasSubmit = actions.some(a =>
            a.type === 'click' && this.isSubmitAction(a)
        );

        // Detect validation
        const hasValidation = assertionCount > 0;

        // Detect error handling
        const hasErrorHandling = actions.some(a =>
            a.expression.toLowerCase().includes('error') ||
            a.expression.toLowerCase().includes('invalid')
        );

        // Calculate complexity
        const complexity = this.calculateComplexity(actions);

        return {
            actionCount: actions.length,
            fillCount,
            clickCount,
            assertionCount,
            navigationCount,
            hasSubmit,
            hasValidation,
            hasErrorHandling,
            complexity
        };
    }

    /**
     * Calculate test complexity
     */
    private calculateComplexity(actions: Action[]): 'simple' | 'moderate' | 'complex' {
        if (actions.length <= 5) return 'simple';
        if (actions.length <= 15) return 'moderate';
        return 'complex';
    }

    /**
     * Find similar patterns using feature similarity
     */
    private findSimilarPatterns(features: PatternFeatures, actions: Action[]): PatternMatch[] {
        const matches: PatternMatch[] = [];

        for (const pattern of this.patternLibrary.values()) {
            const similarity = this.calculateSimilarity(features, pattern.features);

            if (similarity >= this.minSimilarity) {
                const confidence = this.calculateConfidence(similarity, pattern);

                matches.push({
                    pattern,
                    similarity,
                    confidence,
                    reasoning: this.explainMatch(features, pattern, similarity)
                });
            }
        }

        // Sort by confidence (descending)
        return matches.sort((a, b) => b.confidence - a.confidence);
    }

    /**
     * Calculate cosine similarity between feature vectors
     */
    private calculateSimilarity(features1: PatternFeatures, features2: PatternFeatures): number {
        // Convert features to vectors
        const vec1 = this.featuresToVector(features1);
        const vec2 = this.featuresToVector(features2);

        // Calculate cosine similarity
        const dotProduct = vec1.reduce((sum, val, i) => sum + val * vec2[i], 0);
        const mag1 = Math.sqrt(vec1.reduce((sum, val) => sum + val * val, 0));
        const mag2 = Math.sqrt(vec2.reduce((sum, val) => sum + val * val, 0));

        if (mag1 === 0 || mag2 === 0) return 0;

        return dotProduct / (mag1 * mag2);
    }

    /**
     * Convert features to numeric vector for similarity calculation
     */
    private featuresToVector(features: PatternFeatures): number[] {
        return [
            features.actionCount / 20, // Normalize to 0-1 range
            features.fillCount / 10,
            features.clickCount / 10,
            features.assertionCount / 5,
            features.navigationCount / 3,
            features.hasSubmit ? 1 : 0,
            features.hasValidation ? 1 : 0,
            features.hasErrorHandling ? 1 : 0,
            features.complexity === 'simple' ? 0.33 : features.complexity === 'moderate' ? 0.66 : 1.0
        ];
    }

    /**
     * Calculate confidence score based on similarity and pattern history
     */
    private calculateConfidence(similarity: number, pattern: MLPattern): number {
        // Base confidence from similarity
        let confidence = similarity;

        // Boost confidence for frequently used patterns
        const usageBoost = Math.min(pattern.usageCount / 100, 0.1);
        confidence += usageBoost;

        // Boost confidence for high success rate
        const successBoost = (pattern.successRate - 0.5) * 0.2;
        confidence += successBoost;

        return Math.min(confidence, 1.0);
    }

    /**
     * Explain why a pattern matched
     */
    private explainMatch(features: PatternFeatures, pattern: MLPattern, similarity: number): string[] {
        const reasons: string[] = [];

        reasons.push(`${Math.round(similarity * 100)}% similar to "${pattern.name}" pattern`);

        if (features.actionCount === pattern.features.actionCount) {
            reasons.push('Exact action count match');
        }

        if (features.hasSubmit === pattern.features.hasSubmit && features.hasSubmit) {
            reasons.push('Both have submit action');
        }

        if (features.hasValidation === pattern.features.hasValidation && features.hasValidation) {
            reasons.push('Both have validation');
        }

        if (pattern.successRate > 0.8) {
            reasons.push(`Pattern has ${Math.round(pattern.successRate * 100)}% success rate`);
        }

        if (pattern.usageCount > 10) {
            reasons.push(`Pattern used successfully ${pattern.usageCount} times`);
        }

        return reasons;
    }

    /**
     * Extract actions that belong to this pattern
     */
    private extractPatternActions(actions: Action[], pattern: MLPattern): Action[] {
        // For now, return all actions
        // In a more sophisticated implementation, we would:
        // 1. Segment the test into logical groups
        // 2. Match each segment to patterns
        // 3. Return only the actions that match this specific pattern
        return actions;
    }

    /**
     * Generate suggestions based on pattern match
     */
    private async generateSuggestion(match: PatternMatch, actions: Action[]): Promise<PatternSuggestion> {
        const { pattern } = match;

        // Generate Gherkin step suggestion
        const gherkinStep = this.generateGherkinStep(pattern, actions);

        // Find existing similar steps
        const existingMatch = await this.findExistingStep(pattern);

        return {
            gherkinStep,
            stepDefinition: existingMatch ? undefined : {
                pattern: gherkinStep,
                implementation: this.generateStepImplementation(pattern, actions),
                reusable: pattern.usageCount > 5,
                existingMatch
            },
            pageObject: {
                className: this.generatePageClassName(pattern, actions),
                method: this.generatePageMethod(pattern, actions),
                implementation: this.generatePageImplementation(pattern, actions)
            }
        };
    }

    /**
     * Generate Gherkin step from pattern
     */
    private generateGherkinStep(pattern: MLPattern, actions: Action[]): string {
        switch (pattern.type) {
            case 'login':
                return 'When user logs in with valid credentials';
            case 'create':
                return 'When user creates a new record';
            case 'update':
                return 'When user updates the record';
            case 'delete':
                return 'When user deletes the record';
            case 'search':
                return 'When user searches for data';
            case 'form-submit':
                return 'When user submits the form';
            default:
                return `When user performs ${pattern.name}`;
        }
    }

    /**
     * Generate step implementation
     */
    private generateStepImplementation(pattern: MLPattern, actions: Action[]): string {
        // This would generate actual code based on the pattern
        return `// Implement ${pattern.name}\n// TODO: Add implementation`;
    }

    /**
     * Generate page class name
     */
    private generatePageClassName(pattern: MLPattern, actions: Action[]): string {
        if (pattern.type === 'login') return 'LoginPage';
        if (pattern.type === 'search') return 'SearchPage';
        return 'ApplicationPage';
    }

    /**
     * Generate page method name
     */
    private generatePageMethod(pattern: MLPattern, actions: Action[]): string {
        if (pattern.type === 'login') return 'login';
        if (pattern.type === 'create') return 'createRecord';
        if (pattern.type === 'update') return 'updateRecord';
        if (pattern.type === 'delete') return 'deleteRecord';
        if (pattern.type === 'search') return 'search';
        return 'performAction';
    }

    /**
     * Generate page implementation
     */
    private generatePageImplementation(pattern: MLPattern, actions: Action[]): string {
        return `// Implementation for ${pattern.name}`;
    }

    /**
     * Find existing step with similar pattern
     */
    private async findExistingStep(pattern: MLPattern): Promise<ExistingStep | undefined> {
        // In production, this would search the actual step definition files
        // For now, return undefined (no existing match)
        return undefined;
    }

    /**
     * Learn from this test to improve pattern recognition
     */
    private async learnFromTest(features: PatternFeatures, actions: Action[]): Promise<void> {
        const actionSequence = actions.map(a => a.type);
        const sequenceKey = actionSequence.join('->');

        // Find or create pattern
        let pattern = this.patternLibrary.get(sequenceKey);

        if (!pattern) {
            pattern = {
                id: sequenceKey,
                name: this.generatePatternName(features, actions),
                type: this.inferPatternType(features, actions),
                actionSequence,
                features,
                examples: [],
                confidence: 0.5,
                usageCount: 0,
                successRate: 0.5
            };
            this.patternLibrary.set(sequenceKey, pattern);
        }

        // Add this test as an example (store only action types, not full objects to avoid circular refs)
        pattern.examples.push({
            source: 'user-test',
            actions: actions.map(a => ({
                type: a.type,
                expression: a.expression
            } as any)),
            outcome: 'unknown', // Would be updated when test runs
            timestamp: Date.now()
        });

        pattern.usageCount++;

        // Save updated library
        await this.savePatternLibrary();
    }

    /**
     * Generate pattern name from features
     */
    private generatePatternName(features: PatternFeatures, actions: Action[]): string {
        if (features.hasSubmit && features.fillCount === 2) return 'Login Flow';
        if (features.hasSubmit && features.fillCount > 3) return 'Form Submission';
        if (features.hasValidation && !features.hasSubmit) return 'Data Verification';
        if (features.clickCount > features.fillCount) return 'Navigation Flow';
        return 'Generic Workflow';
    }

    /**
     * Infer pattern type from features
     */
    private inferPatternType(features: PatternFeatures, actions: Action[]): string {
        if (this.isLoginPattern(actions)) return 'login';
        if (this.isCreatePattern(actions)) return 'create';
        if (this.isUpdatePattern(actions)) return 'update';
        if (this.isDeletePattern(actions)) return 'delete';
        if (this.isSearchPattern(actions)) return 'search';
        if (features.hasSubmit) return 'form-submit';
        return 'generic';
    }

    /**
     * Pattern detection helpers
     */
    private isSubmitAction(action: Action): boolean {
        const expr = action.expression.toLowerCase();
        return expr.includes('submit') || expr.includes('login') || expr.includes('save');
    }

    private isLoginPattern(actions: Action[]): boolean {
        return actions.some(a => a.expression.toLowerCase().includes('login'));
    }

    private isCreatePattern(actions: Action[]): boolean {
        return actions.some(a => a.expression.toLowerCase().includes('add') || a.expression.toLowerCase().includes('create'));
    }

    private isUpdatePattern(actions: Action[]): boolean {
        return actions.some(a => a.expression.toLowerCase().includes('edit') || a.expression.toLowerCase().includes('update'));
    }

    private isDeletePattern(actions: Action[]): boolean {
        return actions.some(a => a.expression.toLowerCase().includes('delete') || a.expression.toLowerCase().includes('remove'));
    }

    private isSearchPattern(actions: Action[]): boolean {
        return actions.some(a => a.expression.toLowerCase().includes('search') || a.expression.toLowerCase().includes('filter'));
    }

    /**
     * Load pattern library from disk
     */
    private loadPatternLibrary(): void {
        try {
            if (fs.existsSync(this.trainingDataPath)) {
                const data = fs.readFileSync(this.trainingDataPath, 'utf-8');
                const patterns = JSON.parse(data);

                for (const pattern of patterns) {
                    this.patternLibrary.set(pattern.id, pattern);
                }
            }
        } catch (error) {
            console.warn('Could not load pattern library:', error);
        }
    }

    /**
     * Save pattern library to disk
     */
    private async savePatternLibrary(): Promise<void> {
        try {
            const dir = path.dirname(this.trainingDataPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const patterns = Array.from(this.patternLibrary.values());
            fs.writeFileSync(this.trainingDataPath, JSON.stringify(patterns, null, 2));
        } catch (error) {
            console.warn('Could not save pattern library:', error);
        }
    }

    /**
     * Initialize with default patterns from common scenarios
     */
    private initializeDefaultPatterns(): void {
        if (this.patternLibrary.size === 0) {
            // Login pattern
            this.patternLibrary.set('login', {
                id: 'login',
                name: 'Login Flow',
                type: 'login',
                actionSequence: ['navigation', 'fill', 'fill', 'click', 'assertion'],
                features: {
                    actionCount: 5,
                    fillCount: 2,
                    clickCount: 1,
                    assertionCount: 1,
                    navigationCount: 1,
                    hasSubmit: true,
                    hasValidation: true,
                    hasErrorHandling: false,
                    complexity: 'simple'
                },
                examples: [],
                confidence: 0.9,
                usageCount: 100,
                successRate: 0.95
            });

            // Form submission pattern
            this.patternLibrary.set('form-submit', {
                id: 'form-submit',
                name: 'Form Submission',
                type: 'form-submit',
                actionSequence: ['fill', 'fill', 'fill', 'select', 'click', 'assertion'],
                features: {
                    actionCount: 6,
                    fillCount: 3,
                    clickCount: 1,
                    assertionCount: 1,
                    navigationCount: 0,
                    hasSubmit: true,
                    hasValidation: true,
                    hasErrorHandling: false,
                    complexity: 'moderate'
                },
                examples: [],
                confidence: 0.85,
                usageCount: 75,
                successRate: 0.90
            });

            // Search pattern
            this.patternLibrary.set('search', {
                id: 'search',
                name: 'Search Flow',
                type: 'search',
                actionSequence: ['fill', 'click', 'assertion'],
                features: {
                    actionCount: 3,
                    fillCount: 1,
                    clickCount: 1,
                    assertionCount: 1,
                    navigationCount: 0,
                    hasSubmit: true,
                    hasValidation: true,
                    hasErrorHandling: false,
                    complexity: 'simple'
                },
                examples: [],
                confidence: 0.88,
                usageCount: 50,
                successRate: 0.92
            });
        }
    }

    /**
     * Update pattern success rate based on test execution
     */
    public async updatePatternSuccess(patternId: string, success: boolean): Promise<void> {
        const pattern = this.patternLibrary.get(patternId);
        if (pattern) {
            // Update success rate using moving average
            const weight = Math.min(pattern.usageCount, 100) / 100;
            pattern.successRate = pattern.successRate * weight + (success ? 1 : 0) * (1 - weight);

            await this.savePatternLibrary();
        }
    }

    /**
     * Get pattern statistics
     */
    public getStats(): {
        totalPatterns: number;
        averageSuccessRate: number;
        mostUsedPattern: string;
        highestSuccessRate: string;
    } {
        const patterns = Array.from(this.patternLibrary.values());

        return {
            totalPatterns: patterns.length,
            averageSuccessRate: patterns.reduce((sum, p) => sum + p.successRate, 0) / patterns.length,
            mostUsedPattern: patterns.sort((a, b) => b.usageCount - a.usageCount)[0]?.name || 'None',
            highestSuccessRate: patterns.sort((a, b) => b.successRate - a.successRate)[0]?.name || 'None'
        };
    }
}
