/**
 * Strategy Optimizer - Optimizes healing strategy selection based on historical success
 * Learns which strategies work best for different element types and failure scenarios
 */

import { CSReporter } from '../../reporter/CSReporter';
import { CSAIHistory } from './CSAIHistory';
import {
    HealingStrategy,
    FailureType,
    StrategyEffectiveness,
    ElementFeatures
} from '../types/AITypes';

export class CSStrategyOptimizer {
    private static instance: CSStrategyOptimizer;
    private aiHistory: CSAIHistory;
    private strategyPriorities: Map<string, number> = new Map();
    private learningEnabled: boolean = true;

    private constructor() {
        this.aiHistory = CSAIHistory.getInstance();
        this.initializeDefaultPriorities();
        CSReporter.debug('[CSStrategyOptimizer] Initialized');
    }

    public static getInstance(): CSStrategyOptimizer {
        if (!CSStrategyOptimizer.instance) {
            CSStrategyOptimizer.instance = new CSStrategyOptimizer();
        }
        return CSStrategyOptimizer.instance;
    }

    /**
     * Initialize default strategy priorities
     */
    private initializeDefaultPriorities(): void {
        this.strategyPriorities.set('alternative_locators', 10);
        this.strategyPriorities.set('scroll_into_view', 9);
        this.strategyPriorities.set('wait_for_visible', 8);
        this.strategyPriorities.set('remove_overlays', 7);
        this.strategyPriorities.set('close_modal', 7);
        this.strategyPriorities.set('pattern_based_search', 6);
        this.strategyPriorities.set('visual_similarity', 5);
        this.strategyPriorities.set('dom_traversal', 4);
        this.strategyPriorities.set('text_based_search', 3);
        this.strategyPriorities.set('force_click', 1);
    }

    /**
     * Optimize strategy order based on context
     */
    public optimizeStrategies(
        strategies: HealingStrategy[],
        context: {
            failureType: FailureType;
            elementFeatures?: ElementFeatures;
            previousAttempts?: string[];
        }
    ): HealingStrategy[] {
        if (!this.learningEnabled) {
            return strategies;
        }

        CSReporter.debug('[StrategyOptimizer] Optimizing strategy selection');

        // Get strategy effectiveness from history
        const effectiveness = this.aiHistory.getStrategyEffectiveness();

        // Create effectiveness map
        const effectivenessMap = new Map<string, StrategyEffectiveness>();
        effectiveness.forEach(e => effectivenessMap.set(e.strategy, e));

        // Score each strategy
        const scored = strategies.map(strategy => {
            let score = strategy.priority;

            // Boost score based on historical success
            const stats = effectivenessMap.get(strategy.name);
            if (stats) {
                // Success rate boost (0-5 points)
                score += stats.successRate * 5;

                // Element type relevance boost (0-3 points)
                if (context.elementFeatures) {
                    const elementType = this.extractElementType(context.elementFeatures);
                    const typeRelevance = stats.elementTypes[elementType] || 0;
                    score += Math.min(typeRelevance / 10, 3);
                }

                // Recent usage boost (0-2 points)
                if (stats.attempts > 0) {
                    score += Math.min(stats.attempts / 20, 2);
                }
            }

            // Failure type specific boost
            score += this.getFailureTypeBoost(strategy.name, context.failureType);

            // Penalty for previously attempted strategies
            if (context.previousAttempts && context.previousAttempts.includes(strategy.name)) {
                score -= 5;
            }

            return { strategy, score };
        });

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);

        const optimized = scored.map(s => s.strategy);

        CSReporter.debug(`[StrategyOptimizer] Optimized ${optimized.length} strategies`);
        return optimized;
    }

    /**
     * Get strategy boost based on failure type
     */
    private getFailureTypeBoost(strategyName: string, failureType: FailureType): number {
        const boosts: Record<FailureType, Record<string, number>> = {
            'ElementNotFound': {
                'alternative_locators': 3,
                'pattern_based_search': 2,
                'visual_similarity': 2,
                'dom_traversal': 1
            },
            'ElementNotVisible': {
                'scroll_into_view': 3,
                'wait_for_visible': 2,
                'remove_overlays': 1
            },
            'ElementNotInteractive': {
                'remove_overlays': 3,
                'close_modal': 2,
                'wait_for_visible': 1,
                'force_click': 1
            },
            'ModalBlocking': {
                'close_modal': 3,
                'remove_overlays': 2
            },
            'Timeout': {
                'wait_for_visible': 2,
                'scroll_into_view': 1
            },
            'NetworkError': {},
            'JavaScriptError': {},
            'UnexpectedState': {
                'alternative_locators': 1
            },
            'Unknown': {}
        };

        return boosts[failureType]?.[strategyName] || 0;
    }

    /**
     * Suggest best strategy for element type
     */
    public suggestBestStrategy(elementType: string, failureType?: FailureType): string | null {
        // First check history
        const bestFromHistory = this.aiHistory.getBestStrategyForElementType(elementType);

        if (bestFromHistory) {
            CSReporter.debug(`[StrategyOptimizer] Suggesting ${bestFromHistory} for ${elementType} based on history`);
            return bestFromHistory;
        }

        // Fallback to default suggestions
        const defaults: Record<string, string> = {
            'button': 'alternative_locators',
            'input': 'wait_for_visible',
            'link': 'text_based_search',
            'select': 'pattern_based_search',
            'checkbox': 'visual_similarity',
            'modal': 'close_modal'
        };

        return defaults[elementType] || 'alternative_locators';
    }

    /**
     * Learn from healing result
     */
    public learn(
        strategyName: string,
        success: boolean,
        elementType: string,
        failureType: FailureType,
        confidence: number
    ): void {
        if (!this.learningEnabled) return;

        // Adjust strategy priority based on success
        const currentPriority = this.strategyPriorities.get(strategyName) || 5;

        if (success) {
            // Increase priority slightly for successful strategies
            const boost = confidence * 0.5; // Max boost of 0.5
            this.strategyPriorities.set(strategyName, currentPriority + boost);
        } else {
            // Decrease priority slightly for failed strategies
            this.strategyPriorities.set(strategyName, Math.max(1, currentPriority - 0.2));
        }

        CSReporter.debug(`[StrategyOptimizer] Learned from ${strategyName}: ${success ? 'success' : 'failure'}`);
    }

    /**
     * Get recommended strategies for context
     */
    public getRecommendedStrategies(
        failureType: FailureType,
        elementFeatures?: ElementFeatures,
        maxStrategies: number = 5
    ): string[] {
        const recommendations: Array<{ strategy: string; score: number }> = [];

        // Get all strategies from history
        const effectiveness = this.aiHistory.getStrategyEffectiveness();

        effectiveness.forEach(stats => {
            let score = stats.successRate * 10;

            // Add failure type relevance
            score += this.getFailureTypeBoost(stats.strategy, failureType);

            // Add element type relevance
            if (elementFeatures) {
                const elementType = this.extractElementType(elementFeatures);
                const typeRelevance = stats.elementTypes[elementType] || 0;
                score += typeRelevance * 0.1;
            }

            // Add recent usage factor
            score += Math.min(stats.attempts / 100, 1);

            recommendations.push({
                strategy: stats.strategy,
                score
            });
        });

        // Sort by score and return top N
        recommendations.sort((a, b) => b.score - a.score);

        return recommendations
            .slice(0, maxStrategies)
            .map(r => r.strategy);
    }

    /**
     * Get strategy priority
     */
    public getStrategyPriority(strategyName: string): number {
        return this.strategyPriorities.get(strategyName) || 5;
    }

    /**
     * Update strategy priority
     */
    public setStrategyPriority(strategyName: string, priority: number): void {
        this.strategyPriorities.set(strategyName, priority);
        CSReporter.debug(`[StrategyOptimizer] Set ${strategyName} priority to ${priority}`);
    }

    /**
     * Reset strategy priorities to defaults
     */
    public resetPriorities(): void {
        this.strategyPriorities.clear();
        this.initializeDefaultPriorities();
        CSReporter.debug('[StrategyOptimizer] Reset strategy priorities to defaults');
    }

    /**
     * Enable/disable learning
     */
    public setLearningEnabled(enabled: boolean): void {
        this.learningEnabled = enabled;
        CSReporter.debug(`[StrategyOptimizer] Learning ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Get optimization statistics
     */
    public getStatistics(): {
        totalOptimizations: number;
        averageStrategiesPerOptimization: number;
        mostRecommendedStrategy: string | null;
        leastRecommendedStrategy: string | null;
        learningEnabled: boolean;
    } {
        const effectiveness = this.aiHistory.getStrategyEffectiveness();

        const mostRecommended = effectiveness.length > 0
            ? effectiveness.sort((a, b) => b.successRate - a.successRate)[0].strategy
            : null;

        const leastRecommended = effectiveness.length > 0
            ? effectiveness.sort((a, b) => a.successRate - b.successRate)[0].strategy
            : null;

        return {
            totalOptimizations: effectiveness.reduce((sum, e) => sum + e.attempts, 0),
            averageStrategiesPerOptimization: effectiveness.length > 0
                ? effectiveness.reduce((sum, e) => sum + e.attempts, 0) / effectiveness.length
                : 0,
            mostRecommendedStrategy: mostRecommended,
            leastRecommendedStrategy: leastRecommended,
            learningEnabled: this.learningEnabled
        };
    }

    /**
     * Get strategy comparison
     */
    public compareStrategies(strategy1: string, strategy2: string): {
        strategy1: string;
        strategy2: string;
        winner: string;
        difference: number;
    } {
        const effectiveness = this.aiHistory.getStrategyEffectiveness();

        const stats1 = effectiveness.find(e => e.strategy === strategy1);
        const stats2 = effectiveness.find(e => e.strategy === strategy2);

        const score1 = stats1 ? stats1.successRate * 100 : 0;
        const score2 = stats2 ? stats2.successRate * 100 : 0;

        const winner = score1 > score2 ? strategy1 : score2 > score1 ? strategy2 : 'tie';
        const difference = Math.abs(score1 - score2);

        return {
            strategy1,
            strategy2,
            winner,
            difference
        };
    }

    /**
     * Helper: Extract element type from features
     */
    private extractElementType(features: ElementFeatures): string {
        // Check semantic type first
        if (features.semantic.semanticType !== 'generic') {
            return features.semantic.semanticType;
        }

        // Check role
        if (features.semantic.role && features.semantic.role !== 'generic') {
            return features.semantic.role;
        }

        // Check tag name
        return features.structural.tagName;
    }

    /**
     * Export optimizer data
     */
    public export() {
        const priorities: Record<string, number> = {};
        this.strategyPriorities.forEach((value, key) => {
            priorities[key] = value;
        });

        return {
            priorities,
            statistics: this.getStatistics(),
            effectiveness: this.aiHistory.getStrategyEffectiveness()
        };
    }

    /**
     * Import optimizer data
     */
    public import(data: { priorities: Record<string, number> }): void {
        this.strategyPriorities.clear();
        Object.entries(data.priorities).forEach(([strategy, priority]) => {
            this.strategyPriorities.set(strategy, priority);
        });
        CSReporter.debug('[StrategyOptimizer] Imported strategy priorities');
    }
}
