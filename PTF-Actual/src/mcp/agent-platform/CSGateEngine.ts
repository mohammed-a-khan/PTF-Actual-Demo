/**
 * Agentic Test Platform — Gate Engine (Rebuild M3)
 *
 * Generic 3-retry gate wrapper used at every phase transition. Pattern:
 *
 *   1. Run the gate's check function.
 *   2. If it passes → write a `phase_completed` event, advance.
 *   3. If it fails → invoke the resolver function (typically LLM-driven)
 *      with the failure context; capture prompt + response + outcome to
 *      `Agent-Processing/<run>/<phase>/retries/attempt-<N>/`.
 *   4. Re-run the check. If it passes now → write `gate_resolved`, advance.
 *   5. If still failing, repeat steps 3–4 up to `maxRetries` (default 3).
 *   6. If retries are exhausted → call `onExhausted` (which may proceed
 *      with degraded confidence, write a `REVIEW_REQUIRED:` marker, or
 *      block on user via `CSElicitation`).
 *
 * **Why 3 attempts.** Industry-standard bounded recovery — survey of 70
 * agent systems found 3-5 to be the canonical ceiling before human
 * escalation. Anthropic's published agent harness uses the same shape.
 *
 * **Non-blocking by default.** When the user has not authorised user-input
 * gates, exhausted retries write a degraded-confidence outcome and let
 * the pipeline proceed; the trust score reflects this. The user reads
 * `STATUS.md` asynchronously and reviews on completion.
 *
 * @module agent-platform/CSGateEngine
 */

import { CSRunContext, RunPhase } from './CSRunContext';

// ============================================================================
// Public Types
// ============================================================================

/**
 * Result of one gate check. The caller (gate engine) acts on `passed`;
 * `details` is appended to the timeline + retry artefacts for auditability.
 */
export interface GateCheckResult {
    passed: boolean;
    /** Human-readable reason the gate did or did not pass. */
    reason: string;
    /** Optional structured payload retained in the timeline + retry outcome. */
    details?: Record<string, unknown>;
}

/**
 * Output of an LLM (or deterministic) resolver for a failed gate. The
 * resolver inspects the failure and produces a corrective action; the
 * gate engine runs the gate's check again to decide whether the action
 * worked.
 */
export interface GateResolveResult {
    /** What the resolver did, in human-readable terms. */
    summary: string;
    /** The prompt sent to the LLM, if any (logged for audit). */
    prompt?: string;
    /** The LLM's verbatim response, if any. */
    response?: string;
    /** Optional structured payload (e.g. patched IR, suggested fix). */
    payload?: Record<string, unknown>;
}

/**
 * Decision returned by `onExhausted` when all retries are spent.
 *   - `proceed_degraded`: continue the pipeline with a warning + reduced
 *     trust score; record the outcome in the run folder.
 *   - `block_user`: stop the pipeline and elicit user input; the master
 *     tool returns `BLOCKED_NEED_INPUT`.
 *   - `abort`: fatal error; the pipeline writes `run_aborted` and stops.
 */
export type ExhaustedDecision = 'proceed_degraded' | 'block_user' | 'abort';

export interface ExhaustedOutcome {
    decision: ExhaustedDecision;
    /** Active-imperative reason surfaced to the user. */
    reason: string;
    /** Optional structured details — nextSuggestedTool args, etc. */
    details?: Record<string, unknown>;
}

/**
 * Configuration for one gate invocation. The engine wires:
 *   - `phase`         — RunPhase being gated (drives folder naming)
 *   - `runContext`    — shared CSRunContext for this run
 *   - `check`         — async function returning `GateCheckResult`
 *   - `resolve`       — async function invoked on each retry; receives
 *                       previous attempts so it can refine its strategy
 *   - `onExhausted`   — invoked when all retries failed; returns the
 *                       fallback decision
 *   - `maxRetries`    — default 3 (industry-standard bounded recovery)
 */
export interface GateRunOptions {
    phase: RunPhase;
    runContext: CSRunContext;
    check: () => Promise<GateCheckResult>;
    resolve: (
        previousFailure: GateCheckResult,
        attempt: number,
        priorAttempts: ResolutionAttempt[],
    ) => Promise<GateResolveResult>;
    onExhausted: (
        finalFailure: GateCheckResult,
        attempts: ResolutionAttempt[],
    ) => Promise<ExhaustedOutcome>;
    maxRetries?: number;
}

/** Record of one resolver attempt — persisted to the retry folder. */
export interface ResolutionAttempt {
    attemptNumber: number;
    failureBeforeAttempt: GateCheckResult;
    resolveResult: GateResolveResult;
    checkResultAfter: GateCheckResult;
}

/** Final outcome the gate engine returns to the caller. */
export interface GateRunOutcome {
    phase: RunPhase;
    /** Whether the gate ultimately passed (first try OR after retries). */
    passed: boolean;
    /** Was the pass achieved by the LLM resolver vs first-try clean? */
    autoResolved: boolean;
    /** Number of retry attempts made (0 if first-try pass). */
    retriesUsed: number;
    /** Final check result that decided pass/fail. */
    finalCheck: GateCheckResult;
    /** When all retries spent without passing — the exhaust path's outcome. */
    exhausted?: ExhaustedOutcome;
    /** All resolution attempts, in order. Empty when first-try pass. */
    attempts: ResolutionAttempt[];
}

// ============================================================================
// CSGateEngine
// ============================================================================

export class CSGateEngine {
    private static readonly DEFAULT_MAX_RETRIES = 3;

    /**
     * Run one phase's gate end-to-end. The phase is marked `running` at
     * entry and `done` / `auto_resolved` / `blocked_user` at exit. Every
     * retry attempt is logged to `<phase>/retries/attempt-<N>/`.
     */
    public static async runGate(options: GateRunOptions): Promise<GateRunOutcome> {
        const {
            phase,
            runContext,
            check,
            resolve,
            onExhausted,
            maxRetries = CSGateEngine.DEFAULT_MAX_RETRIES,
        } = options;

        runContext.startPhase(phase);

        // -- First attempt: just run the check. --------------------------
        let firstCheck: GateCheckResult;
        try {
            firstCheck = await check();
        } catch (err) {
            firstCheck = {
                passed: false,
                reason: `gate check threw: ${err instanceof Error ? err.message : String(err)}`,
                details: { errorKind: 'check_threw' },
            };
        }

        if (firstCheck.passed) {
            runContext.finishPhase(phase, 'done');
            return {
                phase,
                passed: true,
                autoResolved: false,
                retriesUsed: 0,
                finalCheck: firstCheck,
                attempts: [],
            };
        }

        // -- Retry loop. -------------------------------------------------
        const attempts: ResolutionAttempt[] = [];
        let lastFailure = firstCheck;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            runContext.recordRetry(phase, attempt);

            // Run the resolver.
            let resolveResult: GateResolveResult;
            try {
                resolveResult = await resolve(lastFailure, attempt, attempts.slice());
            } catch (err) {
                resolveResult = {
                    summary: `resolver threw: ${err instanceof Error ? err.message : String(err)}`,
                };
            }

            // Re-run the gate check.
            let checkAfter: GateCheckResult;
            try {
                checkAfter = await check();
            } catch (err) {
                checkAfter = {
                    passed: false,
                    reason: `gate re-check threw: ${err instanceof Error ? err.message : String(err)}`,
                    details: { errorKind: 'recheck_threw' },
                };
            }

            // Persist attempt artefacts for audit.
            const attemptRecord: ResolutionAttempt = {
                attemptNumber: attempt,
                failureBeforeAttempt: lastFailure,
                resolveResult,
                checkResultAfter: checkAfter,
            };
            attempts.push(attemptRecord);
            runContext.writeRetryAttempt(phase, attempt, {
                prompt: resolveResult.prompt,
                response: resolveResult.response,
                outcome: {
                    failureBeforeAttempt: lastFailure,
                    resolveSummary: resolveResult.summary,
                    resolvePayload: resolveResult.payload,
                    checkResultAfter: checkAfter,
                },
            });

            if (checkAfter.passed) {
                runContext.finishPhase(phase, 'auto_resolved');
                return {
                    phase,
                    passed: true,
                    autoResolved: true,
                    retriesUsed: attempt,
                    finalCheck: checkAfter,
                    attempts,
                };
            }

            lastFailure = checkAfter;
        }

        // -- Exhausted. --------------------------------------------------
        const exhausted = await onExhausted(lastFailure, attempts.slice());

        if (exhausted.decision === 'proceed_degraded') {
            // Treat as auto-resolved with degraded confidence — pipeline
            // advances; trust score reflects the unresolved gate.
            runContext.finishPhase(phase, 'auto_resolved', {
                reason: `proceed_degraded: ${exhausted.reason}`,
            });
        } else {
            runContext.finishPhase(phase, 'blocked_user', {
                reason: exhausted.reason,
            });
        }

        return {
            phase,
            passed: exhausted.decision === 'proceed_degraded',
            autoResolved: false,
            retriesUsed: maxRetries,
            finalCheck: lastFailure,
            exhausted,
            attempts,
        };
    }
}
