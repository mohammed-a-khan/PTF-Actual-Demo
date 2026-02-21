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
export { csAI, configureAIStepEngine, getAIStepConfig, flushAIStepCache } from './CSAIStepFunction';

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
// Accuracy & Self-Healing Modules (Phase 1-3)
// ============================================================================

/** MutationObserver-based smart waits for DOM stability */
export { CSMutationObserverWait } from './CSMutationObserverWait';
export type { DOMStabilityOptions, StabilityResult } from './CSMutationObserverWait';

/** Post-action verification (detects silent action failures) */
export { CSPostActionVerifier } from './CSPostActionVerifier';
export type { DOMStateSnapshot, ElementStateSnapshot, VerificationResult } from './CSPostActionVerifier';

/** Enhanced fuzzy matching (N-gram + token + Jaro-Winkler composite) */
export { CSFuzzyMatcher } from './CSFuzzyMatcher';
export type { FuzzyMatchResult } from './CSFuzzyMatcher';

/** Multi-signal element fingerprinting with LCS self-healing */
export { CSElementFingerprint } from './CSElementFingerprint';
export type { ElementFingerprint, StoredFingerprint } from './CSElementFingerprint';

/** Persistent cross-run element cache with adaptive confidence */
export { CSElementCache } from './CSElementCache';
export type { CacheEntry, PageStats } from './CSElementCache';

/** Rule-based compound instruction decomposer */
export { CSInstructionDecomposer } from './CSInstructionDecomposer';
export type { DecomposedInstruction, SubInstruction } from './CSInstructionDecomposer';

/** Visual stability detection via screenshot comparison */
export { CSVisualStabilityDetector } from './CSVisualStabilityDetector';
export type { VisualComparisonResult } from './CSVisualStabilityDetector';

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
