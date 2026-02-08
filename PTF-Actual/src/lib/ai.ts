/**
 * CS Playwright Test Framework - AI Entry Point
 *
 * Only exports AI-specific modules
 *
 * @example
 * import { CSAIEngine, CSIntelligentAI } from '@mdakhan.mak/cs-playwright-test-framework/ai';
 */

// AI Core
export {CSAIEngine} from '../ai/CSAIEngine';
export {CSIntelligentAI} from '../ai/CSIntelligentAI';
export { CSAIContextManager } from '../ai/CSAIContextManager';

//AI Integration
export { CSAIIntegrationLayer } from '../ai/integration/CSAIIntegrationLayer';

//AI Prediction
export {CSPredictiveHealer} from '../ai/prediction/CSPredictiveHealer';

//AI Natural Language Processing
export {CSNaturalLanguageEngine} from '../ai/nlp/CSNaturalLanguageEngine';

//AI Pattern Matching
export {CSPatternMatcher} from '../ai/patterns/CSPatternMatcher';

//AI Learning
export { CSAIHistory } from '../ai/learning/CSAIHistory';
export {CSStrategyOptimizer} from '../ai/learning/CSStrategyOptimizer';
export { CSPatternLearner } from '../ai/learning/CSPatternLearner';

//AI Healing
export { CSIntelligentHealer } from '../ai/healing/CSIntelligentHealer';

//AI Feature Extraction
export { CSFeatureExtractor } from '../ai/features/CSFeatureExtractor';

//AI DOM Intelligence
export { CSDOMIntelligence } from '../ai/analysis/CSDOMIntelligence';

//AI Similarity
export { CSSimilarityEngine } from '../ai/similarity/CSSimilarityEngine';

//AI Utilities
export { CSLocatorExtractor } from '../ai/utils/CSLocatorExtractor';

//AI Types
export * from '../ai/types/AITypes';

// AI Step Engine (Zero-Step: Grammar-based NLP + Accessibility Tree matching)
export { csAI, configureAIStepEngine, getAIStepConfig } from '../ai/step-engine/CSAIStepFunction';
export { CSAIStepBDD, createAIStepHandler, registerAISteps } from '../ai/step-engine/CSAIStepBDD';
export { CSAIStepGrammar } from '../ai/step-engine/CSAIStepGrammar';
export { CSAIStepParser } from '../ai/step-engine/CSAIStepParser';
export { CSAccessibilityTreeMatcher } from '../ai/step-engine/CSAccessibilityTreeMatcher';
export { CSAIActionExecutor } from '../ai/step-engine/CSAIActionExecutor';