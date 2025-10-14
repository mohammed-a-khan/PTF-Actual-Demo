/**
 * CS Playwright Test Framework - AI & Self-Healing Entry Point
 *
 * Lightweight entry point for AI and self-healing features
 *
 * @example
 * import { CSAIEngine, CSSelfHealingEngine } from '@mdakhan.mak/cs-playwright-test-framework/ai';
 */

// Core (minimal)
export { CSConfigurationManager } from '../core/CSConfigurationManager';
export { CSReporter } from '../reporter/CSReporter';

// AI & Self-Healing
export { CSAIEngine } from '../ai/CSAIEngine';
export { CSSelfHealingEngine } from '../self-healing/CSSelfHealingEngine';

// AI Integration Layer
export { CSAIIntegrationLayer } from '../ai/integration/CSAIIntegrationLayer';

// AI Context Manager
export { CSAIContextManager } from '../ai/CSAIContextManager';

// Predictive Healing
export { CSPredictiveHealer } from '../ai/prediction/CSPredictiveHealer';

// Intelligent AI
export { CSIntelligentAI } from '../ai/CSIntelligentAI';

// Locator Extractor
export { CSLocatorExtractor } from '../ai/utils/CSLocatorExtractor';

// Element & Browser (needed for AI healing)
export { CSWebElement } from '../element/CSWebElement';
export { CSElementResolver } from '../element/CSElementResolver';
export { CSBrowserManager } from '../browser/CSBrowserManager';

// Utilities
export { CSValueResolver } from '../utils/CSValueResolver';
