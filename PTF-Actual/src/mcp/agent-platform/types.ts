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
    /**
     * Sequential-Thinking-style continuation flag. When true, the host LLM
     * should call `cs_ai_auto_assist` again with the suggested next input.
     * When false, the run reached a terminal state (READY or BLOCKED).
     * The single-boolean contract is what keeps the agent loop from
     * abandoning the tool after one call.
     */
    nextStepNeeded?: boolean;
    /**
     * Optional name of the tool the LLM should consider calling next.
     * Either `cs_ai_auto_assist` (most common — re-invoke with new args)
     * or a Copilot built-in like `apply_patch` / `read_file` / `run_in_terminal`.
     */
    nextSuggestedTool?: string;
    /**
     * Optional argument template for the next tool call. Keys are arg names,
     * values are either concrete values to use or short descriptions of what
     * the LLM should fill in.
     */
    nextSuggestedArgs?: Record<string, unknown>;
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

// ============================================================================
// Pipeline Output (rebuild architecture)
// ============================================================================

/**
 * One scenario in a generated feature file. Minimum surface needed by the
 * ADO create-back flow and the heal/publish gates. Replaces the previous
 * heavy `GenerationResult.featureFile.scenarios` shape from the deleted
 * `CSGenerationOrchestrator`.
 */
export interface GeneratedScenarioSummary {
    /** Scenario identifier (e.g. `TS_<n>`, `<feature>_<n>`, or generated). */
    id: string;
    /** Human-readable title — what appears as `Scenario:` text in Gherkin. */
    title: string;
    /** Tags above the scenario, including any `@TC_<n>` already attached. */
    tags: string[];
    /** When known: ADO test case id this scenario maps to. */
    tcId?: number;
}

/**
 * One generated feature file plus its parsed scenarios. The ADO create-back
 * flow walks `scenarios` to decide which need new ADO test cases created.
 */
export interface GeneratedFeatureSummary {
    /** Absolute path on disk. */
    filePath: string;
    /** Feature file content (Gherkin source). */
    content: string;
    /** Scenarios discovered in the feature. */
    scenarios: GeneratedScenarioSummary[];
}

/**
 * Aggregate output of the new pipeline. Distinct from the deleted
 * `GenerationResult` — this carries only what downstream consumers
 * (ADO create-back, heal loop, publish, trust score) actually need.
 *
 * The full per-run state (analysis report, call trees, retries, timeline)
 * lives under `Agent-Processing/<ts>_<runId>/` — accessed via
 * `CSRunContext`, not threaded through return types.
 */
export interface PipelineOutput {
    /** runId of the per-run artifact folder. */
    runId: string;
    /** Pipeline version that produced this output. */
    pipelineVersion: string;
    /** Every file written, absolute paths. */
    filesCreated: string[];
    /** Feature files emitted, parsed for downstream consumption. */
    featureFiles: GeneratedFeatureSummary[];
    /** Optional warnings non-fatal to the run. */
    warnings?: string[];
}
