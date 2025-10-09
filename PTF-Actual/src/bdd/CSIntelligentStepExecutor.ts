/**
 * Intelligent Step Executor - Zero-Code Step Execution
 *
 * Enables users to run feature files without writing step definitions.
 * Uses AI/NLP to understand and execute steps automatically.
 *
 * Features:
 * - Natural language step understanding
 * - Automatic element identification
 * - Intelligent action execution
 * - Falls back to custom step definitions if defined
 */

import { Page } from 'playwright';
import { CSBDDContext } from './CSBDDContext';
import { CSReporter } from '../reporter/CSReporter';
import { CSConfigurationManager } from '../core/CSConfigurationManager';

// Lazy load AI modules
let CSIntelligentAI: any = null;
let CSNaturalLanguageEngine: any = null;

export interface IntelligentStepResult {
    success: boolean;
    action?: string;
    element?: string;
    message?: string;
}

export class CSIntelligentStepExecutor {
    private static instance: CSIntelligentStepExecutor;
    private config: CSConfigurationManager;
    private intelligentAI: any;
    private nlpEngine: any;
    private enabled: boolean;

    private constructor() {
        this.config = CSConfigurationManager.getInstance();
        this.enabled = this.config.getBoolean('INTELLIGENT_STEP_EXECUTION_ENABLED', false);
        this.intelligentAI = null;
        this.nlpEngine = null;
    }

    public static getInstance(): CSIntelligentStepExecutor {
        if (!CSIntelligentStepExecutor.instance) {
            CSIntelligentStepExecutor.instance = new CSIntelligentStepExecutor();
        }
        return CSIntelligentStepExecutor.instance;
    }

    /**
     * Check if intelligent step execution is enabled
     */
    public isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Enable intelligent step execution
     */
    public enable(): void {
        this.enabled = true;
    }

    /**
     * Disable intelligent step execution
     */
    public disable(): void {
        this.enabled = false;
    }

    /**
     * Initialize AI modules (lazy loading)
     */
    private async ensureAIModules(): Promise<void> {
        if (!this.intelligentAI) {
            if (!CSIntelligentAI) {
                CSIntelligentAI = require('../ai/CSIntelligentAI').CSIntelligentAI;
            }
            this.intelligentAI = CSIntelligentAI.getInstance();
        }

        if (!this.nlpEngine) {
            if (!CSNaturalLanguageEngine) {
                CSNaturalLanguageEngine = require('../ai/nlp/CSNaturalLanguageEngine').CSNaturalLanguageEngine;
            }
            this.nlpEngine = CSNaturalLanguageEngine.getInstance();
        }
    }

    /**
     * Execute step intelligently without step definition
     */
    public async executeIntelligently(
        stepText: string,
        stepType: string,
        context: CSBDDContext,
        page: Page
    ): Promise<IntelligentStepResult> {
        if (!this.enabled) {
            return {
                success: false,
                message: 'Intelligent step execution is disabled'
            };
        }

        try {
            await this.ensureAIModules();

            CSReporter.debug(`[IntelligentStep] Executing: ${stepType} ${stepText}`);

            // Step 1: Parse step using NLP
            const nlpResult = await this.nlpEngine.processDescription(stepText);
            CSReporter.debug(`[IntelligentStep] NLP Intent: ${nlpResult.intent}, Element: ${nlpResult.elementType}, Keywords: ${nlpResult.keywords.join(', ')}`);

            // Step 2: Execute based on intent
            const result = await this.executeIntent(nlpResult, stepText, page, context);

            if (result.success) {
                CSReporter.info(`[IntelligentStep] ✅ Auto-executed: ${stepType} ${stepText}`);
            } else {
                CSReporter.debug(`[IntelligentStep] ❌ Failed: ${result.message}`);
            }

            return result;

        } catch (error: any) {
            CSReporter.debug(`[IntelligentStep] Error: ${error.message}`);
            return {
                success: false,
                message: error.message
            };
        }
    }

    /**
     * Execute action based on NLP intent
     */
    private async executeIntent(
        nlpResult: any,
        stepText: string,
        page: Page,
        context: CSBDDContext
    ): Promise<IntelligentStepResult> {
        const intent = nlpResult.intent;

        switch (intent) {
            case 'navigate':
                return await this.executeNavigate(stepText, page, context);

            case 'click':
                return await this.executeClick(nlpResult, stepText, page, context);

            case 'type':
                return await this.executeType(nlpResult, stepText, page, context);

            case 'select':
                return await this.executeSelect(nlpResult, stepText, page, context);

            case 'validate':
            case 'assert':
                return await this.executeAssert(nlpResult, stepText, page, context);

            case 'wait':
                return await this.executeWait(nlpResult, stepText, page);

            default:
                return {
                    success: false,
                    message: `Unknown intent: ${intent}`
                };
        }
    }

    /**
     * Execute navigate action
     */
    private async executeNavigate(
        stepText: string,
        page: Page,
        context: CSBDDContext
    ): Promise<IntelligentStepResult> {
        try {
            // Extract URL from step text or use base URL
            let url = this.config.get('BASE_URL', '');

            // Check for URL in step text
            const urlMatch = stepText.match(/https?:\/\/[^\s]+/);
            if (urlMatch) {
                url = urlMatch[0];
            }

            // Check for "navigate to {app}" pattern
            const appMatch = stepText.match(/navigate to (?:the )?(.+?)(?:\s+application|\s+app|\s+page|$)/i);
            if (appMatch && !url) {
                // Use base URL
                url = this.config.get('BASE_URL', '');
            }

            if (!url) {
                return {
                    success: false,
                    message: 'No URL found in step text or configuration'
                };
            }

            await page.goto(url, { waitUntil: 'domcontentloaded' });

            return {
                success: true,
                action: 'navigate',
                element: url,
                message: `Navigated to ${url}`
            };
        } catch (error: any) {
            return {
                success: false,
                message: `Navigation failed: ${error.message}`
            };
        }
    }

    /**
     * Execute click action
     */
    private async executeClick(
        nlpResult: any,
        stepText: string,
        page: Page,
        context: CSBDDContext
    ): Promise<IntelligentStepResult> {
        try {
            // Identify element using AI
            const identificationResult = await this.intelligentAI.identifyElement(
                stepText,
                page,
                { testName: 'intelligent-step', stepText }
            );

            if (!identificationResult || !identificationResult.locator) {
                return {
                    success: false,
                    message: 'Could not identify element to click'
                };
            }

            // Click the element
            await identificationResult.locator.click({ timeout: 10000 });

            return {
                success: true,
                action: 'click',
                element: identificationResult.description || stepText,
                message: `Clicked element: ${identificationResult.description}`
            };
        } catch (error: any) {
            return {
                success: false,
                message: `Click failed: ${error.message}`
            };
        }
    }

    /**
     * Execute type action
     */
    private async executeType(
        nlpResult: any,
        stepText: string,
        page: Page,
        context: CSBDDContext
    ): Promise<IntelligentStepResult> {
        try {
            // Extract text to type (in quotes)
            const textMatch = stepText.match(/['"]([^'"]+)['"]/);
            if (!textMatch) {
                return {
                    success: false,
                    message: 'Could not extract text to type from step'
                };
            }
            const textToType = textMatch[1];

            // Identify element using AI
            const identificationResult = await this.intelligentAI.identifyElement(
                stepText,
                page,
                { testName: 'intelligent-step', stepText }
            );

            if (!identificationResult || !identificationResult.locator) {
                return {
                    success: false,
                    message: 'Could not identify input element'
                };
            }

            // Type the text
            await identificationResult.locator.fill(textToType, { timeout: 10000 });

            return {
                success: true,
                action: 'type',
                element: identificationResult.description || stepText,
                message: `Typed "${textToType}" into ${identificationResult.description}`
            };
        } catch (error: any) {
            return {
                success: false,
                message: `Type failed: ${error.message}`
            };
        }
    }

    /**
     * Execute select action (dropdown)
     */
    private async executeSelect(
        nlpResult: any,
        stepText: string,
        page: Page,
        context: CSBDDContext
    ): Promise<IntelligentStepResult> {
        try {
            // Extract option to select (in quotes)
            const optionMatch = stepText.match(/['"]([^'"]+)['"]/);
            if (!optionMatch) {
                return {
                    success: false,
                    message: 'Could not extract option to select from step'
                };
            }
            const optionToSelect = optionMatch[1];

            // Identify dropdown using AI
            const identificationResult = await this.intelligentAI.identifyElement(
                stepText,
                page,
                { testName: 'intelligent-step', stepText }
            );

            if (!identificationResult || !identificationResult.locator) {
                return {
                    success: false,
                    message: 'Could not identify dropdown element'
                };
            }

            // Select the option
            await identificationResult.locator.selectOption(optionToSelect, { timeout: 10000 });

            return {
                success: true,
                action: 'select',
                element: identificationResult.description || stepText,
                message: `Selected "${optionToSelect}" from ${identificationResult.description}`
            };
        } catch (error: any) {
            return {
                success: false,
                message: `Select failed: ${error.message}`
            };
        }
    }

    /**
     * Execute assert action (verify)
     */
    private async executeAssert(
        nlpResult: any,
        stepText: string,
        page: Page,
        context: CSBDDContext
    ): Promise<IntelligentStepResult> {
        try {
            // Check what to assert
            if (stepText.toLowerCase().includes('should see') ||
                stepText.toLowerCase().includes('should be visible') ||
                stepText.toLowerCase().includes('should display') ||
                stepText.toLowerCase().includes('should appear')) {

                // Extract keywords from NLP result
                const keywords = nlpResult.keywords || [];

                // Try to find text/heading on page first (faster and more reliable for page validations)
                if (keywords.length > 0) {
                    // Filter out common words
                    const meaningfulKeywords = keywords.filter((k: string) =>
                        !['should', 'see', 'the', 'page', 'display', 'appear', 'visible'].includes(k.toLowerCase())
                    );

                    // Try each keyword as text content
                    for (const keyword of meaningfulKeywords) {
                        try {
                            // Check if page contains the text (case-insensitive)
                            const pageText = await page.textContent('body');
                            if (pageText && pageText.toLowerCase().includes(keyword.toLowerCase())) {
                                return {
                                    success: true,
                                    action: 'assert_text_visible',
                                    element: keyword,
                                    message: `Verified page contains text: "${keyword}"`
                                };
                            }

                            // Try as heading (h1-h6)
                            const headingLocator = page.locator(`h1, h2, h3, h4, h5, h6`).filter({ hasText: new RegExp(keyword, 'i') });
                            const headingCount = await headingLocator.count();
                            if (headingCount > 0) {
                                return {
                                    success: true,
                                    action: 'assert_heading_visible',
                                    element: keyword,
                                    message: `Verified heading contains text: "${keyword}"`
                                };
                            }
                        } catch (e) {
                            // Continue to next keyword
                        }
                    }
                }

                // Fallback: Try to identify element using AI
                const identificationResult = await this.intelligentAI.identifyElement(
                    stepText,
                    page,
                    { testName: 'intelligent-step', stepText }
                );

                if (!identificationResult || !identificationResult.locator) {
                    return {
                        success: false,
                        message: `Could not verify: "${stepText}" - text/element not found on page`
                    };
                }

                // Check if visible
                const isVisible = await identificationResult.locator.isVisible();
                if (!isVisible) {
                    return {
                        success: false,
                        message: 'Element exists but is not visible'
                    };
                }

                return {
                    success: true,
                    action: 'assert_visible',
                    element: identificationResult.description || stepText,
                    message: `Verified element is visible: ${identificationResult.description}`
                };
            }

            // URL assertion
            if (stepText.toLowerCase().includes('url should') || stepText.toLowerCase().includes('should contain')) {
                const currentUrl = page.url();
                const urlMatch = stepText.match(/['"]([^'"]+)['"]/);
                if (urlMatch) {
                    const expectedUrl = urlMatch[1];
                    if (currentUrl.includes(expectedUrl)) {
                        return {
                            success: true,
                            action: 'assert_url',
                            element: currentUrl,
                            message: `URL contains "${expectedUrl}"`
                        };
                    } else {
                        return {
                            success: false,
                            message: `URL "${currentUrl}" does not contain "${expectedUrl}"`
                        };
                    }
                }
            }

            return {
                success: false,
                message: 'Unknown assertion type'
            };
        } catch (error: any) {
            return {
                success: false,
                message: `Assertion failed: ${error.message}`
            };
        }
    }

    /**
     * Execute wait action
     */
    private async executeWait(
        nlpResult: any,
        stepText: string,
        page: Page
    ): Promise<IntelligentStepResult> {
        try {
            // Extract timeout
            const timeoutMatch = stepText.match(/(\d+)\s*(second|sec|ms|millisecond)/i);
            let timeout = 1000; // Default 1 second

            if (timeoutMatch) {
                const value = parseInt(timeoutMatch[1]);
                const unit = timeoutMatch[2].toLowerCase();
                if (unit.startsWith('sec')) {
                    timeout = value * 1000;
                } else {
                    timeout = value;
                }
            }

            await page.waitForTimeout(timeout);

            return {
                success: true,
                action: 'wait',
                message: `Waited ${timeout}ms`
            };
        } catch (error: any) {
            return {
                success: false,
                message: `Wait failed: ${error.message}`
            };
        }
    }
}
