/**
 * AI Integration Layer - Thread-safe integration for BDD Runner
 *
 * Features:
 * - Works with both parallel and sequential execution
 * - ONLY activates for UI-based steps
 * - Preserves existing retry behavior for API/Database steps
 * - Thread-safe for parallel workers
 */

import { Page } from 'playwright';
import { CSReporter, StepAIData } from '../../reporter/CSReporter';
import { CSAIContextManager } from '../CSAIContextManager';
import { CSIntelligentHealer } from '../healing/CSIntelligentHealer';
import { CSAIHistory } from '../learning/CSAIHistory';
import { CSPredictiveHealer } from '../prediction/CSPredictiveHealer';
import { CSIntelligentAI } from '../CSIntelligentAI';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';

export interface AIIntegrationConfig {
    enabled: boolean;
    healingEnabled: boolean;
    predictionEnabled: boolean;
    learningEnabled: boolean;
    uiOnly: boolean;  // Only activate for UI steps
    confidenceThreshold: number;
    maxHealingAttempts: number;
}

export class CSAIIntegrationLayer {
    private static instances: Map<string, CSAIIntegrationLayer> = new Map();
    private config: AIIntegrationConfig;
    private contextManager: CSAIContextManager;
    private healer: CSIntelligentHealer;
    private predictor: CSPredictiveHealer;
    private aiHistory: CSAIHistory;
    private intelligentAI: CSIntelligentAI;
    private workerId: string;

    private constructor(workerId: string = 'main') {
        this.workerId = workerId;

        // Load configuration
        const configManager = CSConfigurationManager.getInstance();
        this.config = {
            enabled: configManager.getBoolean('AI_ENABLED', true),
            healingEnabled: configManager.getBoolean('AI_INTELLIGENT_HEALING_ENABLED', true),
            predictionEnabled: configManager.getBoolean('AI_PREDICTIVE_HEALING_ENABLED', false),
            learningEnabled: configManager.getBoolean('AI_LEARNING_ENABLED', true),
            uiOnly: configManager.getBoolean('AI_UI_ONLY', true),  // Default: only UI steps
            confidenceThreshold: parseFloat(configManager.get('AI_CONFIDENCE_THRESHOLD', '0.75')),
            maxHealingAttempts: parseInt(configManager.get('AI_MAX_HEALING_ATTEMPTS', '3'))
        };

        // Initialize AI modules
        this.contextManager = CSAIContextManager.getInstance();
        this.healer = CSIntelligentHealer.getInstance();
        this.predictor = CSPredictiveHealer.getInstance();
        this.aiHistory = CSAIHistory.getInstance();
        this.intelligentAI = CSIntelligentAI.getInstance();

        // Configure modules
        this.predictor.setPredictionEnabled(this.config.predictionEnabled);

        CSReporter.debug(`[AIIntegration][${this.workerId}] Initialized - AI: ${this.config.enabled}, Healing: ${this.config.healingEnabled}, UI Only: ${this.config.uiOnly}`);
    }

    /**
     * Get instance for current worker (thread-safe)
     */
    public static getInstance(workerId: string = 'main'): CSAIIntegrationLayer {
        if (!CSAIIntegrationLayer.instances.has(workerId)) {
            CSAIIntegrationLayer.instances.set(workerId, new CSAIIntegrationLayer(workerId));
        }
        return CSAIIntegrationLayer.instances.get(workerId)!;
    }

    /**
     * Check if AI should be activated for this step
     * CRITICAL: Only return true for UI steps, false for API/Database
     */
    public shouldActivateAI(stepText: string): boolean {
        if (!this.config.enabled) {
            return false;
        }

        if (this.config.uiOnly) {
            // Detect step context
            const context = this.contextManager.detectContextFromStep(stepText);

            if (context === 'api') {
                CSReporter.debug(`[AIIntegration][${this.workerId}] AI DISABLED for API step: "${stepText}" - using existing retry behavior`);
                return false;
            }

            if (context === 'database') {
                CSReporter.debug(`[AIIntegration][${this.workerId}] AI DISABLED for database step: "${stepText}" - using existing retry behavior`);
                return false;
            }

            if (context === 'ui') {
                CSReporter.debug(`[AIIntegration][${this.workerId}] AI ENABLED for UI step: "${stepText}"`);
                return true;
            }

            // Unknown context - be conservative, disable AI
            CSReporter.debug(`[AIIntegration][${this.workerId}] AI DISABLED for unknown context: "${stepText}" - using existing retry behavior`);
            return false;
        }

        // UI-only mode disabled, activate for all steps
        return true;
    }

    /**
     * Attempt intelligent healing (ONLY for UI steps)
     */
    public async attemptHealing(
        error: Error,
        context: {
            element?: any;
            page: Page;
            locator: string;
            step: string;
            url: string;
            testName: string;
            scenarioName: string;
        }
    ): Promise<{ healed: boolean; newLocator?: string; healingData?: StepAIData['healing'] }> {
        // Check if AI should activate
        if (!this.shouldActivateAI(context.step)) {
            CSReporter.debug(`[AIIntegration][${this.workerId}] Healing skipped - not a UI step`);
            return { healed: false };
        }

        if (!this.config.healingEnabled) {
            CSReporter.debug(`[AIIntegration][${this.workerId}] Healing disabled in configuration`);
            return { healed: false };
        }

        try {
            CSReporter.debug(`[AIIntegration][${this.workerId}] Attempting intelligent healing for: ${context.step}`);

            const healingResult = await this.healer.heal(error, {
                element: context.element,
                page: context.page,
                locator: context.locator,
                step: context.step,
                url: context.url
            });

            // Record in history
            if (this.config.learningEnabled) {
                this.aiHistory.recordHealing(healingResult, {
                    testName: context.testName,
                    stepText: context.step,
                    featureName: context.scenarioName,
                    url: context.url,
                    elementDescription: context.step
                });
            }

            // Create healing data for reporting
            const healingData: StepAIData['healing'] = {
                attempted: true,
                success: healingResult.success,
                strategy: healingResult.strategy,
                confidence: healingResult.confidence,
                duration: healingResult.duration,
                originalLocator: healingResult.originalLocator,
                healedLocator: healingResult.healedLocator,
                attempts: healingResult.attempts
            };

            // Record in reporter
            CSReporter.recordAIHealing(healingData);

            if (healingResult.success) {
                CSReporter.info(`[AIIntegration][${this.workerId}] ✅ Healing SUCCESS using ${healingResult.strategy} (${(healingResult.confidence * 100).toFixed(1)}% confidence)`);
                return {
                    healed: true,
                    newLocator: healingResult.healedLocator,
                    healingData
                };
            } else {
                CSReporter.debug(`[AIIntegration][${this.workerId}] ❌ Healing FAILED after ${healingResult.attempts} attempts`);
                return {
                    healed: false,
                    healingData
                };
            }

        } catch (error) {
            CSReporter.debug(`[AIIntegration][${this.workerId}] Healing error: ${error}`);
            return { healed: false };
        }
    }

    /**
     * Predict if element will fail (ONLY for UI steps)
     */
    public async predictFailure(
        locator: string,
        page: Page,
        stepText: string
    ): Promise<{ willFail: boolean; fragilityScore: number; predictionData?: StepAIData['prediction'] }> {
        // Check if AI should activate
        if (!this.shouldActivateAI(stepText)) {
            return { willFail: false, fragilityScore: 0 };
        }

        if (!this.config.predictionEnabled) {
            return { willFail: false, fragilityScore: 0 };
        }

        try {
            const prediction = await this.predictor.predictFailure(locator, page);

            if (prediction.willFail) {
                CSReporter.debug(`[AIIntegration][${this.workerId}] ⚠️ Prediction: Element likely to fail (${(prediction.confidence * 100).toFixed(1)}% confidence, ${(prediction.fragilityScore * 100).toFixed(1)}% fragility)`);
            }

            const predictionData: StepAIData['prediction'] = {
                predicted: prediction.willFail,
                prevented: false,  // Will be updated if pre-emptive healing succeeds
                confidence: prediction.confidence,
                fragilityScore: prediction.fragilityScore
            };

            // Record in reporter
            CSReporter.recordAIPrediction(predictionData);

            return {
                willFail: prediction.willFail,
                fragilityScore: prediction.fragilityScore,
                predictionData
            };

        } catch (error) {
            CSReporter.debug(`[AIIntegration][${this.workerId}] Prediction error: ${error}`);
            return { willFail: false, fragilityScore: 0 };
        }
    }

    /**
     * Identify element using natural language (ONLY for UI steps)
     */
    public async identifyElement(
        description: string,
        page: Page,
        context: {
            testName: string;
            scenarioName: string;
            stepText: string;
        }
    ): Promise<{ locator: any | null; identificationData?: StepAIData['identification'] }> {
        // Check if AI should activate
        if (!this.shouldActivateAI(context.stepText)) {
            return { locator: null };
        }

        try {
            const result = await this.intelligentAI.identifyElement(description, page, context);

            if (result) {
                const identificationData: StepAIData['identification'] = {
                    method: result.method,
                    confidence: result.confidence,
                    alternatives: result.alternatives.length,
                    duration: result.duration
                };

                // Record in reporter
                CSReporter.recordAIIdentification(identificationData);

                CSReporter.debug(`[AIIntegration][${this.workerId}] 🔍 Element identified using ${result.method} (${(result.confidence * 100).toFixed(1)}% confidence)`);

                return {
                    locator: result.locator,
                    identificationData
                };
            }

            return { locator: null };

        } catch (error) {
            CSReporter.debug(`[AIIntegration][${this.workerId}] Identification error: ${error}`);
            return { locator: null };
        }
    }

    /**
     * Get AI statistics (thread-safe)
     */
    public getStatistics(): {
        workerId: string;
        healingStats: any;
        historyStats: any;
    } {
        return {
            workerId: this.workerId,
            healingStats: this.healer.getStatistics(),
            historyStats: this.aiHistory.getStatistics()
        };
    }

    /**
     * Check if current context is UI
     */
    public isCurrentContextUI(): boolean {
        return this.contextManager.getCurrentContext() === 'ui';
    }

    /**
     * Set context manually
     */
    public setContext(context: 'ui' | 'api' | 'database' | 'unknown'): void {
        this.contextManager.setContext(context);
    }

    /**
     * Clear worker instance (for cleanup)
     */
    public static clearInstance(workerId: string): void {
        CSAIIntegrationLayer.instances.delete(workerId);
        CSReporter.debug(`[AIIntegration] Cleared instance for worker: ${workerId}`);
    }

    /**
     * Clear all instances
     */
    public static clearAllInstances(): void {
        CSAIIntegrationLayer.instances.clear();
        CSReporter.debug('[AIIntegration] Cleared all worker instances');
    }
}
