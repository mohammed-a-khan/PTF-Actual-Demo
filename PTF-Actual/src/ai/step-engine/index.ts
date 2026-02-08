/**
 * AI Step Engine - Public API
 *
 * Grammar-based NLP + Accessibility Tree element matching for
 * natural language test step execution. No external LLM required.
 *
 * @module ai/step-engine
 *
 * @example
 * // Programmatic usage:
 * import { csAI } from '@mdakhan.mak/cs-playwright-test-framework/ai/step-engine';
 *
 * await csAI('Click the Login button', { page });
 * await csAI("Type 'admin' in the Username field", { page });
 * const text = await csAI('Get the text from the heading', { page });
 *
 * // BDD usage in .feature files:
 * // When AI "Click the Login button"
 * // Then AI "Verify the Dashboard heading is displayed"
 * // When AI "Get the price from Total" and store as "totalPrice"
 */

// ============================================================================
// Main API
// ============================================================================

/** The main csAI() function - primary entry point */
export { csAI, configureAIStepEngine, getAIStepConfig } from './CSAIStepFunction';

// ============================================================================
// BDD Integration
// ============================================================================

/** BDD step handler class and registration */
export { CSAIStepBDD, createAIStepHandler, registerAISteps } from './CSAIStepBDD';

// ============================================================================
// Core Modules (for advanced usage / extensibility)
// ============================================================================

/** Grammar engine for rule-based parsing */
export { CSAIStepGrammar } from './CSAIStepGrammar';

/** Parser orchestrator (grammar + NLP fallback) */
export { CSAIStepParser } from './CSAIStepParser';

/** Accessibility tree element matcher */
export { CSAccessibilityTreeMatcher } from './CSAccessibilityTreeMatcher';

/** Action/assertion/query executor */
export { CSAIActionExecutor } from './CSAIActionExecutor';

// ============================================================================
// Types
// ============================================================================

export type {
    // Step types
    StepCategory,
    StepIntent,
    ActionIntent,
    AssertionIntent,
    QueryIntent,
    ParsedStep,
    ElementTarget,
    StepParameters,
    StepModifiers,

    // Element matching
    MatchedElement,
    AlternativeMatch,
    MatchMethod,

    // Action execution
    ActionResult,

    // Grammar rules (for extensibility)
    GrammarRule,
    GrammarExtraction,

    // Accessibility tree
    AccessibilityNode,
    AccessibilityMatchScore,

    // Configuration
    CSAIStepConfig,
    CSAIOptions
} from './CSAIStepTypes';

// Constants
export {
    DEFAULT_AI_STEP_CONFIG,
    ELEMENT_TYPE_TO_ROLES,
    INTENT_TO_LIKELY_ROLES,
    ACTION_SYNONYMS,
    ELEMENT_TYPE_SYNONYMS,
    ORDINAL_MAP
} from './CSAIStepTypes';
