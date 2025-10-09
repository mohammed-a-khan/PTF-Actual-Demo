/**
 * AI History - Learning system that tracks all AI operations
 * Maintains history of identifications, healings, and predictions for continuous improvement
 */

import { CSReporter } from '../../reporter/CSReporter';
import {
    AIHistoryEntry,
    AIOperationType,
    FragileElement,
    StrategyEffectiveness,
    IntelligentHealingResult
} from '../types/AITypes';

export class CSAIHistory {
    private static instance: CSAIHistory;
    private history: AIHistoryEntry[] = [];
    private maxEntries: number = 10000;
    private fragileElements: Map<string, FragileElement> = new Map();
    private strategyStats: Map<string, StrategyEffectiveness> = new Map();

    private constructor() {
        CSReporter.debug('[CSAIHistory] Initialized');
    }

    public static getInstance(): CSAIHistory {
        if (!CSAIHistory.instance) {
            CSAIHistory.instance = new CSAIHistory();
        }
        return CSAIHistory.instance;
    }

    /**
     * Record an AI operation
     */
    public record(entry: Omit<AIHistoryEntry, 'id' | 'timestamp'>): void {
        const fullEntry: AIHistoryEntry = {
            ...entry,
            id: this.generateId(),
            timestamp: new Date()
        };

        this.history.push(fullEntry);

        // Maintain max size
        if (this.history.length > this.maxEntries) {
            this.history.shift();
        }

        // Update fragile elements if this was a healing
        if (entry.operation === 'healing') {
            this.updateFragileElements(fullEntry);
        }

        // Update strategy statistics
        if (entry.strategy) {
            this.updateStrategyStats(fullEntry);
        }

        CSReporter.debug(`[AIHistory] Recorded ${entry.operation} operation: ${entry.elementDescription}`);
    }

    /**
     * Record healing result
     */
    public recordHealing(result: IntelligentHealingResult, context: {
        testName: string;
        stepText: string;
        featureName: string;
        url: string;
        elementDescription: string;
    }): void {
        this.record({
            operation: 'healing',
            elementDescription: context.elementDescription,
            originalLocator: result.originalLocator,
            healedLocator: result.healedLocator,
            strategy: result.strategy,
            success: result.success,
            confidence: result.confidence,
            duration: result.duration,
            context: {
                url: context.url,
                testName: context.testName,
                stepText: context.stepText,
                featureName: context.featureName
            }
        });
    }

    /**
     * Update fragile elements map
     */
    private updateFragileElements(entry: AIHistoryEntry): void {
        const key = entry.originalLocator || entry.elementDescription;

        if (!this.fragileElements.has(key)) {
            this.fragileElements.set(key, {
                description: entry.elementDescription,
                locator: entry.originalLocator || '',
                healCount: 0,
                lastHealed: entry.timestamp,
                successRate: 0,
                commonFailures: []
            });
        }

        const element = this.fragileElements.get(key)!;
        element.healCount++;
        element.lastHealed = entry.timestamp;

        // Update success rate
        const healings = this.getHealingHistory(key);
        const successes = healings.filter(h => h.success).length;
        element.successRate = healings.length > 0 ? successes / healings.length : 0;

        // Track common failure patterns
        if (!entry.success && entry.strategy) {
            if (!element.commonFailures.includes(entry.strategy)) {
                element.commonFailures.push(entry.strategy);
            }
        }

        // Generate suggested fix if success rate is low
        if (element.healCount >= 3 && element.successRate < 0.5) {
            element.suggestedFix = this.generateSuggestedFix(healings);
        }
    }

    /**
     * Generate suggested fix for fragile element
     */
    private generateSuggestedFix(healings: AIHistoryEntry[]): string {
        const successfulStrategies = healings
            .filter(h => h.success)
            .map(h => h.strategy);

        if (successfulStrategies.length > 0) {
            const mostCommon = this.getMostCommon(successfulStrategies);
            return `Consider using ${mostCommon} strategy or updating locator to be more stable`;
        }

        const healedLocators = healings
            .filter(h => h.success && h.healedLocator)
            .map(h => h.healedLocator!);

        if (healedLocators.length > 0) {
            const mostCommonLocator = this.getMostCommon(healedLocators);
            return `Consider updating locator to: ${mostCommonLocator}`;
        }

        return 'Consider using more stable locator attributes (data-testid, aria-label, or semantic selectors)';
    }

    /**
     * Update strategy statistics
     */
    private updateStrategyStats(entry: AIHistoryEntry): void {
        const strategy = entry.strategy;
        if (!strategy) return;

        if (!this.strategyStats.has(strategy)) {
            this.strategyStats.set(strategy, {
                strategy,
                attempts: 0,
                successes: 0,
                failures: 0,
                successRate: 0,
                averageConfidence: 0,
                averageDuration: 0,
                elementTypes: {}
            });
        }

        const stats = this.strategyStats.get(strategy)!;
        stats.attempts++;

        if (entry.success) {
            stats.successes++;
        } else {
            stats.failures++;
        }

        stats.successRate = stats.successes / stats.attempts;

        // Update average confidence
        if (entry.confidence !== undefined) {
            const totalConfidence = stats.averageConfidence * (stats.attempts - 1) + entry.confidence;
            stats.averageConfidence = totalConfidence / stats.attempts;
        }

        // Update average duration
        const totalDuration = stats.averageDuration * (stats.attempts - 1) + entry.duration;
        stats.averageDuration = totalDuration / stats.attempts;

        // Track element types
        const elementType = this.extractElementType(entry.elementDescription);
        if (elementType) {
            stats.elementTypes[elementType] = (stats.elementTypes[elementType] || 0) + 1;
        }
    }

    /**
     * Get healing history for element
     */
    public getHealingHistory(locator: string): AIHistoryEntry[] {
        return this.history.filter(
            entry => entry.operation === 'healing' &&
                (entry.originalLocator === locator || entry.elementDescription === locator)
        );
    }

    /**
     * Get all entries by operation type
     */
    public getByOperation(operation: AIOperationType): AIHistoryEntry[] {
        return this.history.filter(entry => entry.operation === operation);
    }

    /**
     * Get entries by test name
     */
    public getByTest(testName: string): AIHistoryEntry[] {
        return this.history.filter(entry => entry.context.testName === testName);
    }

    /**
     * Get entries by feature name
     */
    public getByFeature(featureName: string): AIHistoryEntry[] {
        return this.history.filter(entry => entry.context.featureName === featureName);
    }

    /**
     * Get recent entries
     */
    public getRecent(count: number = 10): AIHistoryEntry[] {
        return this.history.slice(-count);
    }

    /**
     * Get fragile elements
     */
    public getFragileElements(minHealCount: number = 2): FragileElement[] {
        const fragile = Array.from(this.fragileElements.values())
            .filter(el => el.healCount >= minHealCount)
            .sort((a, b) => b.healCount - a.healCount);

        return fragile;
    }

    /**
     * Get most fragile element
     */
    public getMostFragileElement(): FragileElement | null {
        const fragile = this.getFragileElements(1);
        return fragile.length > 0 ? fragile[0] : null;
    }

    /**
     * Get strategy effectiveness
     */
    public getStrategyEffectiveness(): StrategyEffectiveness[] {
        return Array.from(this.strategyStats.values())
            .sort((a, b) => b.successRate - a.successRate);
    }

    /**
     * Get best strategy
     */
    public getBestStrategy(): StrategyEffectiveness | null {
        const strategies = this.getStrategyEffectiveness();
        return strategies.length > 0 ? strategies[0] : null;
    }

    /**
     * Get strategy for element type
     */
    public getBestStrategyForElementType(elementType: string): string | null {
        const strategies = this.getStrategyEffectiveness();

        // Filter strategies that have been used with this element type
        const relevantStrategies = strategies.filter(
            s => s.elementTypes[elementType] && s.elementTypes[elementType] > 0
        );

        if (relevantStrategies.length === 0) {
            return null;
        }

        // Sort by success rate and frequency
        relevantStrategies.sort((a, b) => {
            const aScore = a.successRate * a.elementTypes[elementType];
            const bScore = b.successRate * b.elementTypes[elementType];
            return bScore - aScore;
        });

        return relevantStrategies[0].strategy;
    }

    /**
     * Get success rate for test
     */
    public getTestSuccessRate(testName: string): number {
        const entries = this.getByTest(testName);
        if (entries.length === 0) return 0;

        const successful = entries.filter(e => e.success).length;
        return successful / entries.length;
    }

    /**
     * Get overall statistics
     */
    public getStatistics(): {
        totalOperations: number;
        operationsByType: Record<AIOperationType, number>;
        overallSuccessRate: number;
        totalHealings: number;
        successfulHealings: number;
        averageConfidence: number;
        averageDuration: number;
        fragileElementsCount: number;
        mostUsedStrategy: string | null;
    } {
        const operationsByType: Record<AIOperationType, number> = {
            identification: 0,
            healing: 0,
            analysis: 0,
            prediction: 0,
            learning: 0
        };

        let successCount = 0;
        let totalConfidence = 0;
        let confidenceCount = 0;
        let totalDuration = 0;
        let healingCount = 0;
        let successfulHealings = 0;

        this.history.forEach(entry => {
            operationsByType[entry.operation]++;

            if (entry.success) {
                successCount++;
            }

            if (entry.confidence !== undefined) {
                totalConfidence += entry.confidence;
                confidenceCount++;
            }

            totalDuration += entry.duration;

            if (entry.operation === 'healing') {
                healingCount++;
                if (entry.success) {
                    successfulHealings++;
                }
            }
        });

        const strategies = this.getStrategyEffectiveness();
        const mostUsedStrategy = strategies.length > 0
            ? strategies.sort((a, b) => b.attempts - a.attempts)[0].strategy
            : null;

        return {
            totalOperations: this.history.length,
            operationsByType,
            overallSuccessRate: this.history.length > 0 ? successCount / this.history.length : 0,
            totalHealings: healingCount,
            successfulHealings,
            averageConfidence: confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
            averageDuration: this.history.length > 0 ? totalDuration / this.history.length : 0,
            fragileElementsCount: this.fragileElements.size,
            mostUsedStrategy
        };
    }

    /**
     * Get time saved by AI healing
     */
    public getTimeSaved(): number {
        // Assume manual debug time per failure is 10 minutes (600 seconds)
        const manualDebugTime = 600000; // 10 minutes in milliseconds
        const successfulHealings = this.history.filter(
            entry => entry.operation === 'healing' && entry.success
        ).length;

        return successfulHealings * manualDebugTime;
    }

    /**
     * Export history
     */
    public export() {
        return {
            history: [...this.history],
            fragileElements: this.getFragileElements(1),
            strategyEffectiveness: this.getStrategyEffectiveness(),
            statistics: this.getStatistics()
        };
    }

    /**
     * Clear all history
     */
    public clear(): void {
        this.history = [];
        this.fragileElements.clear();
        this.strategyStats.clear();
        CSReporter.debug('[AIHistory] All history cleared');
    }

    /**
     * Set max entries
     */
    public setMaxEntries(max: number): void {
        this.maxEntries = max;
        while (this.history.length > this.maxEntries) {
            this.history.shift();
        }
    }

    /**
     * Helper: Generate unique ID
     */
    private generateId(): string {
        return `ai_hist_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    }

    /**
     * Helper: Get most common item in array
     */
    private getMostCommon<T>(arr: T[]): T | null {
        if (arr.length === 0) return null;

        const counts = new Map<T, number>();
        arr.forEach(item => {
            counts.set(item, (counts.get(item) || 0) + 1);
        });

        let maxCount = 0;
        let mostCommon: T | null = null;

        counts.forEach((count, item) => {
            if (count > maxCount) {
                maxCount = count;
                mostCommon = item;
            }
        });

        return mostCommon;
    }

    /**
     * Helper: Extract element type from description
     */
    private extractElementType(description: string): string | null {
        const lowerDesc = description.toLowerCase();

        const types = ['button', 'input', 'link', 'select', 'checkbox', 'radio', 'textarea', 'table', 'modal', 'menu'];

        for (const type of types) {
            if (lowerDesc.includes(type)) {
                return type;
            }
        }

        return null;
    }

    /**
     * Search history by text
     */
    public search(query: string): AIHistoryEntry[] {
        const lowerQuery = query.toLowerCase();

        return this.history.filter(entry =>
            entry.elementDescription.toLowerCase().includes(lowerQuery) ||
            entry.context.stepText.toLowerCase().includes(lowerQuery) ||
            entry.strategy.toLowerCase().includes(lowerQuery)
        );
    }

    /**
     * Get entries within time range
     */
    public getByTimeRange(startDate: Date, endDate: Date): AIHistoryEntry[] {
        return this.history.filter(
            entry => entry.timestamp >= startDate && entry.timestamp <= endDate
        );
    }

    /**
     * Get success trend over time
     */
    public getSuccessTrend(intervals: number = 10): Array<{ interval: number; successRate: number }> {
        if (this.history.length === 0) {
            return [];
        }

        const chunkSize = Math.ceil(this.history.length / intervals);
        const trend: Array<{ interval: number; successRate: number }> = [];

        for (let i = 0; i < intervals; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, this.history.length);
            const chunk = this.history.slice(start, end);

            const successes = chunk.filter(e => e.success).length;
            const successRate = chunk.length > 0 ? successes / chunk.length : 0;

            trend.push({
                interval: i + 1,
                successRate
            });
        }

        return trend;
    }
}
