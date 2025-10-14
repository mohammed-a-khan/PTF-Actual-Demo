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