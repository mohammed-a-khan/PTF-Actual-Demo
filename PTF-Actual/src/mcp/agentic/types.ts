/**
 * Agentic SDLC Platform — Shared Types
 *
 * One agent (`cs-ai-auto-assist`), thirteen SDLC modes, a deterministic
 * playbook engine, lazy capability packs, and live guardrails. These types
 * are the contracts between the five meta-tools, the catalog, the playbook
 * engine, and the session store.
 *
 * @module agentic/types
 */

import type { DelegationEnvelope } from '../agent-platform/CSDelegationEnvelope';
import type { JsonSchema } from '../agent-platform/CSDelegationSchemas';
import type { MCPToolContext } from '../types/CSMCPTypes';

// ============================================================================
// SDLC Modes
// ============================================================================

/** The eighteen SDLC capabilities the single agent exposes as a menu. */
export type SDLCMode =
    | 'plan'
    | 'analyze'
    | 'design'
    | 'author'
    | 'migrate'
    | 'review'
    | 'pr_review'
    | 'run'
    | 'heal'
    | 'triage'
    | 'regression'
    | 'pr_impact'
    | 'performance'
    | 'audit'
    | 'accessibility'
    | 'security'
    | 'ado_plan'
    | 'ado_automate'
    | 'release'
    | 'load'
    | 'source'
    | 'defect';

/** Input field types renderable both as elicitation forms and text menus. */
export type FieldType = 'string' | 'enum' | 'boolean' | 'number';

/**
 * One user-facing input a mode needs. Renders as a native form field via
 * MCP elicitation (enum → dropdown) or as a line in the text-menu fallback.
 */
export interface ModeInputField {
    id: string;
    title: string;
    description: string;
    type: FieldType;
    required: boolean;
    /** For type 'enum': machine values. */
    options?: string[];
    /** For type 'enum': human labels, index-aligned with options. */
    optionTitles?: string[];
    default?: string | number | boolean;
    /** Optional regex applied to string answers. */
    pattern?: string;
}

/** Catalog entry for one SDLC mode. */
export interface ModeDefinition {
    mode: SDLCMode;
    title: string;
    /** One-line, user-facing. Shown in the mode dropdown / menu. */
    summary: string;
    inputs: ModeInputField[];
    /** Capability packs that must be active while this mode runs. */
    toolPacks: string[];
    /** Ordered stage ids executed by the playbook engine. */
    stages: string[];
}

// ============================================================================
// Stages
// ============================================================================

export type StageKind = 'deterministic' | 'cognitive' | 'handoff' | 'elicit' | 'gate';

/**
 * Outcome of executing (or attempting) one stage. Exactly one of the
 * optional payloads is present depending on `status`.
 */
export interface StageOutcome {
    status:
        | 'complete'          // stage finished; engine may auto-chain to the next
        | 'envelope'          // cognitive stage: LLM must fulfil and csaa_submit
        | 'handoff'           // agent must call pack tools, then csaa_advance with report
        | 'question'          // user decision required (elicitation fell back / declined)
        | 'blocked'           // guardrail block — session halted pending human
        | 'finished';         // playbook complete — final report available
    /** Terse machine summary persisted to the timeline. */
    summary: string;
    /** Cognitive stages: the envelope the host LLM must fulfil. */
    envelope?: DelegationEnvelope;
    /** Handoff stages: directive for the agent. */
    handoff?: HandoffDirective;
    /** Question stages: the pending question (text fallback form). */
    question?: PendingQuestion;
    /** Blocked stages: human-readable reason. */
    blockedReason?: string;
    /** Finished: absolute path of the final report. */
    reportPath?: string;
    /** Artifacts written by this stage (absolute paths). */
    artifacts?: string[];
}

/**
 * Directive returned when a stage delegates to capability-pack tools that
 * the agent itself must call (e.g. the csaa_* authoring chain, or
 * bdd_run_feature). `doneWhen` tells the agent what "finished" looks like;
 * `reportSchema` is what it must pass back to `csaa_advance` as `report`.
 */
export interface HandoffDirective {
    /** Stable id — also used to validate the report on the way back. */
    handoffId: string;
    /** Plain-English brief for the agent. Strict, no prose padding. */
    instruction: string;
    /** First tool to call. */
    nextSuggestedTool: string;
    nextSuggestedArgs?: Record<string, unknown>;
    /** What completion looks like. */
    doneWhen: string;
    /** Schema for the `report` object handed back to csaa_advance. */
    reportSchema: JsonSchema;
    /**
     * Capability packs this handoff needs. Activated by the engine at the
     * moment the directive is emitted (stage-level progressive disclosure —
     * even leaner than per-mode activation) and released with the session.
     */
    packs?: string[];
}

/**
 * A pending question in text-fallback form. When elicitation is available
 * the engine asks inline instead and this shape is never surfaced.
 */
export interface PendingQuestion {
    questionId: string;
    message: string;
    fields: ModeInputField[];
}

// ============================================================================
// Sessions
// ============================================================================

export type SessionState =
    | 'COLLECTING'        // menu shown / inputs incomplete
    | 'ACTIVE'            // playbook advancing
    | 'AWAITING_SUBMIT'   // envelope outstanding
    | 'AWAITING_HANDOFF'  // handoff outstanding
    | 'AWAITING_ANSWER'   // question outstanding
    | 'BLOCKED_NEED_HUMAN'
    | 'BLOCKED_BUDGET'
    | 'COMPLETE'
    | 'CANCELLED';

/** Cumulative, persisted budget/usage numbers for one session. */
export interface SessionUsage {
    estimatedTokens: number;
    toolCalls: number;
    wallClockMs: number;
    estimatedCostUsd: number;
    budgetMaxTokens: number;
    budgetMaxWallClockMs: number;
    budgetMaxCostUsd: number;
    /** Times the user explicitly extended a blown budget. */
    budgetExtensions: number;
}

/** Serialized session — the on-disk system of record (session.json). */
export interface SessionRecord {
    sessionId: string;
    mode: SDLCMode;
    state: SessionState;
    createdAt: string;
    updatedAt: string;
    /**
     * Start of the CURRENT active period — refreshed whenever a session is
     * re-hydrated from disk. The wall-clock budget measures this period, not
     * lifetime, so resuming tomorrow doesn't instantly trip the budget.
     */
    activeSince: string;
    /** Redacted/validated user inputs keyed by field id. */
    inputs: Record<string, string | number | boolean>;
    /** Index into the mode's stage list. */
    stageIndex: number;
    /** Stage id currently outstanding (envelope/handoff/question). */
    pendingStageId?: string;
    /** Envelope currently awaiting csaa_submit (if any). */
    pendingEnvelope?: DelegationEnvelope;
    /** Handoff currently awaiting a report (if any). */
    pendingHandoff?: HandoffDirective;
    /** Question currently awaiting an answer (if any). */
    pendingQuestion?: PendingQuestion;
    /** Chunk buffer for multi-part csaa_submit calls. */
    submitBuffer?: string;
    /** Retries used for the current envelope (max 3). */
    submitRetries: number;
    /** Heal cycles consumed (bounded). */
    healCycles: number;
    /** Auto-advance steps consumed (bounded runaway protection). */
    stepsExecuted: number;
    usage: SessionUsage;
    /** Absolute session folder. */
    folder: string;
    /** Artifacts registered so far (absolute paths). */
    artifacts: string[];
    /** Per-stage summaries for STATUS.md. */
    stageLog: Array<{ stageId: string; status: string; summary: string; at: string }>;
    /** Guardrail verdicts of record (trust score etc). */
    trustScore?: number;
    trustLevel?: string;
    blockedReason?: string;
    /** Linked agent-platform runId when a handoff spawned one (author/migrate). */
    linkedRunId?: string;
    /** True once this session's tool packs have been released. */
    packsReleased?: boolean;
    /** Every pack activated for this session (mode-level + stage-level). */
    activatedPacks?: string[];
}

// ============================================================================
// Meta-tool results
// ============================================================================

/**
 * Uniform envelope every meta-tool returns in structuredContent. The agent
 * prompt is written against exactly this shape — keep it stable.
 */
export interface AgenticToolResult {
    ok: boolean;
    sessionId?: string;
    mode?: SDLCMode;
    state?: SessionState;
    /** What the host agent should do next. */
    action:
        | 'show_menu'         // present `menu` verbatim, then re-call front door
        | 'ask_user'          // present `question` verbatim, then re-call with answers
        | 'call_tool'         // call nextSuggestedTool with nextSuggestedArgs
        | 'fulfil_envelope'   // produce JSON per envelope, call csaa_submit
        | 'advance'           // call csaa_advance
        | 'done'              // surface finalReport to the user, stop
        | 'stop';             // blocked — surface reason, wait for human
    menu?: TextMenu;
    question?: PendingQuestion;
    envelope?: DelegationEnvelope;
    handoff?: HandoffDirective;
    nextSuggestedTool?: string;
    nextSuggestedArgs?: Record<string, unknown>;
    statusPath?: string;
    reportPath?: string;
    blockedReason?: string;
    /** Terse, single-line progress note (agent may relay verbatim). */
    note?: string;
    usage?: Pick<SessionUsage, 'estimatedTokens' | 'toolCalls' | 'estimatedCostUsd'>;
}

/** Numbered text menu — the no-elicitation fallback rendering. */
export interface TextMenu {
    title: string;
    prompt: string;
    options: Array<{ n: number; value: string; label: string; hint?: string }>;
}

// ============================================================================
// Stage executor context
// ============================================================================

/** Everything a stage executor may touch. */
export interface StageContext {
    session: SessionRecord;
    mcp: MCPToolContext;
    workspaceRoot: string;
    /** Persist an artifact under the session's artifacts/ folder. */
    writeArtifact: (relPath: string, content: string) => string;
    /** Record a guardrailed token estimate (chars / 4). */
    recordTokens: (chars: number) => void;
    /** Payload handed back by csaa_submit for the pending envelope. */
    submission?: unknown;
    /** Report handed back by csaa_advance for the pending handoff. */
    handoffReport?: Record<string, unknown>;
    /** Answers handed back for the pending question. */
    answers?: Record<string, string | number | boolean>;
}

/** One stage in a playbook. */
export interface StageDefinition {
    id: string;
    kind: StageKind;
    title: string;
    /**
     * Execute the stage. For cognitive/handoff/elicit stages the first call
     * returns the envelope/handoff/question; the engine re-invokes the same
     * stage with `submission`/`handoffReport`/`answers` set to finish it.
     */
    run: (ctx: StageContext) => Promise<StageOutcome> | StageOutcome;
}
