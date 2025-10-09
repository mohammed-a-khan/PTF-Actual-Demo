/**
 * Predictive Healer - Predicts failures before they happen and performs pre-emptive healing
 * Uses historical data and fragility scoring (NO external AI APIs)
 */

import { Page, Locator } from 'playwright';
import { CSReporter } from '../../reporter/CSReporter';
import { CSAIHistory } from '../learning/CSAIHistory';
import { CSFeatureExtractor } from '../features/CSFeatureExtractor';
import {
    PredictionResult,
    FragilityScore,
    ElementFeatures,
    FragileElement
} from '../types/AITypes';

export class CSPredictiveHealer {
    private static instance: CSPredictiveHealer;
    private aiHistory: CSAIHistory;
    private featureExtractor: CSFeatureExtractor;
    private predictionEnabled: boolean = false; // Disabled by default per user requirements
    private fragilityCacheTime: number = 300000; // 5 minutes
    private fragilityCache: Map<string, { score: FragilityScore; timestamp: number }> = new Map();

    private constructor() {
        this.aiHistory = CSAIHistory.getInstance();
        this.featureExtractor = CSFeatureExtractor.getInstance();
        CSReporter.debug('[CSPredictiveHealer] Initialized');
    }

    public static getInstance(): CSPredictiveHealer {
        if (!CSPredictiveHealer.instance) {
            CSPredictiveHealer.instance = new CSPredictiveHealer();
        }
        return CSPredictiveHealer.instance;
    }

    /**
     * Predict if element interaction will fail
     */
    public async predictFailure(
        locator: string | Locator,
        page?: Page
    ): Promise<PredictionResult> {
        if (!this.predictionEnabled) {
            return {
                willFail: false,
                confidence: 0,
                fragilityScore: 0
            };
        }

        try {
            CSReporter.debug(`[PredictiveHealer] Predicting failure for: ${typeof locator === 'string' ? locator : 'Locator'}`);

            const locatorString = typeof locator === 'string' ? locator : await this.getLocatorString(locator);

            // Calculate fragility score
            const fragilityScore = await this.calculateFragilityScore(locatorString);

            // Determine if likely to fail based on fragility
            const willFail = fragilityScore.score > 0.5; // Threshold for prediction
            const confidence = this.calculatePredictionConfidence(fragilityScore);

            // Get suggested alternative if fragile
            let suggestedLocator: string | undefined;
            if (willFail) {
                suggestedLocator = this.getSuggestedLocator(locatorString);
            }

            const prediction: PredictionResult = {
                willFail,
                confidence,
                fragilityScore: fragilityScore.score,
                reason: this.generatePredictionReason(fragilityScore),
                suggestedLocator
            };

            CSReporter.debug(`[PredictiveHealer] Prediction: ${willFail ? 'WILL FAIL' : 'OK'} (Confidence: ${(confidence * 100).toFixed(1)}%, Fragility: ${(fragilityScore.score * 100).toFixed(1)}%)`);

            return prediction;

        } catch (error) {
            CSReporter.debug(`[PredictiveHealer] Prediction error: ${error}`);
            return {
                willFail: false,
                confidence: 0,
                fragilityScore: 0
            };
        }
    }

    /**
     * Calculate fragility score for locator
     */
    public async calculateFragilityScore(locator: string): Promise<FragilityScore> {
        // Check cache
        const cached = this.fragilityCache.get(locator);
        if (cached && Date.now() - cached.timestamp < this.fragilityCacheTime) {
            return cached.score;
        }

        try {
            const healingHistory = this.aiHistory.getHealingHistory(locator);
            const healCount = healingHistory.length;

            if (healCount === 0) {
                // No history, assume stable
                return {
                    score: 0.0,
                    healCount: 0,
                    failureRate: 0,
                    locatorStability: 1.0,
                    factors: []
                };
            }

            // Calculate failure rate
            const failures = healingHistory.filter(h => !h.success).length;
            const failureRate = healCount > 0 ? failures / healCount : 0;

            // Calculate locator stability
            const uniqueHealedLocators = new Set(
                healingHistory
                    .filter(h => h.success && h.healedLocator)
                    .map(h => h.healedLocator!)
            );
            const locatorStability = uniqueHealedLocators.size === 0
                ? 1.0
                : Math.max(0, 1 - (uniqueHealedLocators.size / 10)); // More different locators = less stable

            // Get last heal date
            const lastHealDate = healingHistory.length > 0
                ? healingHistory[healingHistory.length - 1].timestamp
                : undefined;

            // Calculate recency factor (recent heals increase fragility)
            let recencyFactor = 0;
            if (lastHealDate) {
                const daysSinceHeal = (Date.now() - lastHealDate.getTime()) / (1000 * 60 * 60 * 24);
                if (daysSinceHeal < 1) recencyFactor = 0.3;      // Healed today
                else if (daysSinceHeal < 7) recencyFactor = 0.2; // Healed this week
                else if (daysSinceHeal < 30) recencyFactor = 0.1; // Healed this month
            }

            // Calculate overall fragility score
            let score = 0;

            // Heal count factor (0-0.4)
            score += Math.min(healCount / 10, 0.4);

            // Failure rate factor (0-0.3)
            score += failureRate * 0.3;

            // Locator instability factor (0-0.2)
            score += (1 - locatorStability) * 0.2;

            // Recency factor (0-0.3)
            score += recencyFactor;

            score = Math.min(score, 1.0);

            // Identify fragility factors
            const factors: string[] = [];
            if (healCount >= 3) factors.push(`Healed ${healCount} times`);
            if (failureRate > 0.3) factors.push(`${(failureRate * 100).toFixed(0)}% failure rate`);
            if (locatorStability < 0.7) factors.push('Unstable locator');
            if (recencyFactor > 0.1) factors.push('Recently healed');

            const fragilityScore: FragilityScore = {
                score,
                healCount,
                lastHealDate,
                failureRate,
                locatorStability,
                factors
            };

            // Cache the score
            this.fragilityCache.set(locator, {
                score: fragilityScore,
                timestamp: Date.now()
            });

            return fragilityScore;

        } catch (error) {
            CSReporter.debug(`[PredictiveHealer] Error calculating fragility: ${error}`);
            return {
                score: 0,
                healCount: 0,
                failureRate: 0,
                locatorStability: 1.0,
                factors: []
            };
        }
    }

    /**
     * Pre-emptively heal fragile element before interaction
     */
    public async preemptiveHeal(
        locator: string | Locator,
        page: Page
    ): Promise<{ healed: boolean; newLocator?: string; confidence: number }> {
        if (!this.predictionEnabled) {
            return { healed: false, confidence: 0 };
        }

        try {
            const locatorString = typeof locator === 'string' ? locator : await this.getLocatorString(locator);

            CSReporter.debug(`[PredictiveHealer] Attempting preemptive healing for: ${locatorString}`);

            // Check if element is fragile
            const prediction = await this.predictFailure(locatorString, page);

            if (!prediction.willFail) {
                CSReporter.debug('[PredictiveHealer] Element not fragile, no healing needed');
                return { healed: false, confidence: 0 };
            }

            // Use suggested locator if available
            if (prediction.suggestedLocator) {
                CSReporter.debug(`[PredictiveHealer] Using suggested locator: ${prediction.suggestedLocator}`);

                // Verify suggested locator works
                try {
                    const count = await page.locator(prediction.suggestedLocator).count();
                    if (count > 0) {
                        return {
                            healed: true,
                            newLocator: prediction.suggestedLocator,
                            confidence: prediction.confidence
                        };
                    }
                } catch {
                    // Suggested locator doesn't work
                }
            }

            // Try to find alternative locator based on historical success
            const alternativeLocator = await this.findAlternativeLocator(locatorString, page);

            if (alternativeLocator) {
                CSReporter.debug(`[PredictiveHealer] Found alternative locator: ${alternativeLocator}`);
                return {
                    healed: true,
                    newLocator: alternativeLocator,
                    confidence: 0.7
                };
            }

            CSReporter.debug('[PredictiveHealer] No alternative locator found');
            return { healed: false, confidence: 0 };

        } catch (error) {
            CSReporter.debug(`[PredictiveHealer] Preemptive healing error: ${error}`);
            return { healed: false, confidence: 0 };
        }
    }

    /**
     * Find alternative locator based on history
     */
    private async findAlternativeLocator(locator: string, page: Page): Promise<string | null> {
        const history = this.aiHistory.getHealingHistory(locator);

        // Find most frequently successful healed locator
        const successfulLocators = history
            .filter(h => h.success && h.healedLocator)
            .map(h => h.healedLocator!);

        if (successfulLocators.length === 0) {
            return null;
        }

        // Count occurrences
        const counts = new Map<string, number>();
        successfulLocators.forEach(loc => {
            counts.set(loc, (counts.get(loc) || 0) + 1);
        });

        // Get most common
        let maxCount = 0;
        let mostCommon: string | null = null;

        counts.forEach((count, loc) => {
            if (count > maxCount) {
                maxCount = count;
                mostCommon = loc;
            }
        });

        if (!mostCommon) {
            return null;
        }

        // Verify it exists on page
        try {
            const count = await page.locator(mostCommon).count();
            if (count > 0) {
                return mostCommon;
            }
        } catch {
            // Doesn't work
        }

        return null;
    }

    /**
     * Get suggested locator for fragile element
     */
    private getSuggestedLocator(locator: string): string | undefined {
        const fragileElements = this.aiHistory.getFragileElements();
        const fragile = fragileElements.find(f => f.locator === locator);

        if (fragile && fragile.suggestedFix) {
            // Extract suggested locator from fix message
            const match = fragile.suggestedFix.match(/locator to: (.+)/);
            if (match) {
                return match[1];
            }
        }

        return undefined;
    }

    /**
     * Calculate prediction confidence
     */
    private calculatePredictionConfidence(fragilityScore: FragilityScore): number {
        let confidence = 0.5; // Base confidence

        // More heals = higher confidence in prediction
        if (fragilityScore.healCount >= 5) confidence += 0.3;
        else if (fragilityScore.healCount >= 3) confidence += 0.2;
        else if (fragilityScore.healCount >= 1) confidence += 0.1;

        // Higher failure rate = higher confidence
        if (fragilityScore.failureRate > 0.5) confidence += 0.2;
        else if (fragilityScore.failureRate > 0.3) confidence += 0.1;

        return Math.min(confidence, 1.0);
    }

    /**
     * Generate prediction reason
     */
    private generatePredictionReason(fragilityScore: FragilityScore): string {
        if (fragilityScore.factors.length === 0) {
            return 'Element appears stable';
        }

        return `Element is fragile: ${fragilityScore.factors.join(', ')}`;
    }

    /**
     * Get all fragile elements
     */
    public getFragileElements(): FragileElement[] {
        return this.aiHistory.getFragileElements();
    }

    /**
     * Get elements that need attention
     */
    public async getElementsNeedingAttention(
        minFragility: number = 0.5
    ): Promise<Array<{ locator: string; fragilityScore: FragilityScore }>> {
        const fragile = this.aiHistory.getFragileElements();
        const needingAttention: Array<{ locator: string; fragilityScore: FragilityScore }> = [];

        for (const element of fragile) {
            const score = await this.calculateFragilityScore(element.locator);
            if (score.score >= minFragility) {
                needingAttention.push({
                    locator: element.locator,
                    fragilityScore: score
                });
            }
        }

        // Sort by fragility score descending
        needingAttention.sort((a, b) => b.fragilityScore.score - a.fragilityScore.score);

        return needingAttention;
    }

    /**
     * Enable/disable prediction
     */
    public setPredictionEnabled(enabled: boolean): void {
        this.predictionEnabled = enabled;
        CSReporter.debug(`[PredictiveHealer] Prediction ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Clear fragility cache
     */
    public clearCache(): void {
        this.fragilityCache.clear();
        CSReporter.debug('[PredictiveHealer] Fragility cache cleared');
    }

    /**
     * Get prediction statistics
     */
    public async getStatistics(): Promise<{
        predictionEnabled: boolean;
        fragileElementsCount: number;
        averageFragilityScore: number;
        highRiskElements: number;
        cacheSize: number;
    }> {
        const fragileElements = this.aiHistory.getFragileElements();

        let totalScore = 0;
        let highRisk = 0;

        for (const element of fragileElements) {
            const score = await this.calculateFragilityScore(element.locator);
            totalScore += score.score;
            if (score.score > 0.7) highRisk++;
        }

        return {
            predictionEnabled: this.predictionEnabled,
            fragileElementsCount: fragileElements.length,
            averageFragilityScore: fragileElements.length > 0 ? totalScore / fragileElements.length : 0,
            highRiskElements: highRisk,
            cacheSize: this.fragilityCache.size
        };
    }

    /**
     * Helper: Extract locator string from Locator object
     */
    private async getLocatorString(locator: Locator): Promise<string> {
        try {
            // Try to get locator representation
            return locator.toString();
        } catch {
            return 'unknown_locator';
        }
    }

    /**
     * Generate fragility report
     */
    public async generateFragilityReport(): Promise<{
        summary: {
            totalElements: number;
            criticalElements: number;
            highRiskElements: number;
            mediumRiskElements: number;
            averageScore: number;
        };
        elements: Array<{
            locator: string;
            description: string;
            fragility: FragilityScore;
            recommendation: string;
        }>;
    }> {
        const fragile = this.aiHistory.getFragileElements();

        let totalScore = 0;
        let critical = 0;
        let highRisk = 0;
        let mediumRisk = 0;

        const elements: Array<{
            locator: string;
            description: string;
            fragility: FragilityScore;
            recommendation: string;
        }> = [];

        for (const element of fragile) {
            const fragility = await this.calculateFragilityScore(element.locator);
            totalScore += fragility.score;

            if (fragility.score > 0.8) critical++;
            else if (fragility.score > 0.6) highRisk++;
            else if (fragility.score > 0.4) mediumRisk++;

            elements.push({
                locator: element.locator,
                description: element.description,
                fragility,
                recommendation: element.suggestedFix || 'Consider using more stable locator attributes'
            });
        }

        // Sort by fragility score
        elements.sort((a, b) => b.fragility.score - a.fragility.score);

        return {
            summary: {
                totalElements: fragile.length,
                criticalElements: critical,
                highRiskElements: highRisk,
                mediumRiskElements: mediumRisk,
                averageScore: fragile.length > 0 ? totalScore / fragile.length : 0
            },
            elements
        };
    }
}
