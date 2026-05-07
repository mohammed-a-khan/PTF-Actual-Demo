/**
 * Agentic Test Platform — Shared Types
 *
 * Privacy-by-design: no domain, project, or organization references appear
 * here. All identifiers use generic placeholders such as <MODULE>, <APP_URL>,
 * <USER>, <TEST_PLAN_ID>.
 *
 * @module agent-platform/types
 */

// ============================================================================
// Run Modes
// ============================================================================

/**
 * The classified intent a user input maps to. The router uses these to
 * dispatch the master tool's control flow to the correct generation strategy.
 */
export type AgentRunMode =
    | 'ado_test_case_id'
    | 'ado_test_suite_id'
    | 'ado_test_plan_id'
    | 'natural_language_chat'
    | 'document_path'
    | 'app_url'
    | 'source_code_path'
    | 'legacy_test_code'
    | 'unknown';

/**
 * Terminal state of an agent run. Only RUNNING and READY are non-terminal
 * during a single invocation; READY is the success state on completion.
 */
export type AgentRunState =
    | 'RUNNING'
    | 'READY'
    | 'BLOCKED_NEED_INPUT'
    | 'BLOCKED_NEED_HUMAN'
    | 'BLOCKED_BUDGET'
    | 'BLOCKED_TIMEOUT';

// ============================================================================
// Run Result
// ============================================================================

/**
 * Final result returned by the master agent tool. Always serializable so it
 * can be embedded in MCP tool result structuredContent.
 */
export interface AgentRunResult {
    state: AgentRunState;
    runId: string;
    mode: AgentRunMode;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    tokensTotal: number;
    costUsd: number;
    testsGenerated: number;
    testsPassed: number;
    trustScoreAvg: number;
    filesCreated: string[];
    blockedReason?: string;
    blockedDetails?: Record<string, unknown>;
    clarificationsNeeded?: ClarificationQuestion[];
}

// ============================================================================
// Clarification
// ============================================================================

/**
 * A single tiered question the platform asks before it can proceed.
 *
 *  Tier 1 = blocking (hard required to start)
 *  Tier 2 = important (default-able, but quality suffers without it)
 *  Tier 3 = optional (advanced policy choices)
 */
export interface ClarificationQuestion {
    tier: 1 | 2 | 3;
    field: string;
    question: string;
    required: boolean;
    suggestedDefault?: string;
}

// ============================================================================
// Intent Routing
// ============================================================================

/**
 * Output of the deterministic intent router. `confidence` is a value in
 * [0, 1] derived from how strongly the input matches a deterministic
 * pattern. Anything below 0.5 should be deferred to LLM-based disambiguation
 * (Phase 2) and meanwhile resolved by clarification.
 */
export interface ClassifiedInput {
    mode: AgentRunMode;
    confidence: number;
    extractedFields: Record<string, string>;
    rawInput: string;
}

// ============================================================================
// Result Judgement
// ============================================================================

/**
 * Verdict from the result judge after a test run. Splits the binary
 * pass/fail into three buckets so the orchestrator can distinguish
 * "tests pass but assertions are weak" from "tests pass meaningfully".
 */
export interface JudgeVerdict {
    verdict: 'PASS_REAL' | 'PASS_WEAK' | 'FAIL';
    meaningful: boolean;
    confidence: number;
    weakAssertions: string[];
    missingAssertions: string[];
    redundantAssertions: string[];
    reasoning: string;
}

// ============================================================================
// Constitutional Safety
// ============================================================================

/**
 * A safety violation detected by the constitutional safety check. HARD_BLOCK
 * violations must abort the action; WARN violations should be surfaced but
 * may proceed.
 */
export interface SafetyViolation {
    rule: string;
    severity: 'HARD_BLOCK' | 'WARN';
    description: string;
    attemptedAction: string;
}

// ============================================================================
// Cost / Budget
// ============================================================================

/**
 * Hard limits enforced by the cost telemetry. Any of the three thresholds
 * being exceeded triggers a BLOCKED_BUDGET / BLOCKED_TIMEOUT terminal state.
 */
export interface CostBudget {
    maxTokens: number;
    maxWallClockMs: number;
    maxCostUsd: number;
}

/**
 * Cumulative usage tracked by CSCostTelemetry across a single run.
 */
export interface CostUsage {
    tokensUsed: number;
    wallClockMs: number;
    costUsd: number;
    byModelTier: Record<'cheap' | 'mid' | 'premium', { tokens: number; costUsd: number }>;
}

// ============================================================================
// Trust Score
// ============================================================================

/**
 * Inputs to the trust score formula. All fields contribute to a weighted
 * sum that is clamped into [0, 1]. See CSTrustScore.compute for weights.
 */
export interface TrustScoreInputs {
    sourceGrounded: boolean;
    executed: boolean;
    judgeVerdict: JudgeVerdict['verdict'];
    hasAlternativeLocators: boolean;
    hasMeaningfulAssertions: boolean;
    commitReadyCheckPassed: boolean;
    healCyclesUsed: number;
}
