/**
 * Agentic SDLC Platform — Playbook Engine
 *
 * The deterministic stepper that drives a session through its mode's stage
 * graph. One `advance()` call chains as many consecutive deterministic
 * stages as possible (zero extra host round-trips) and stops only when:
 *
 *   - a cognitive stage needs the LLM        → AWAITING_SUBMIT (envelope)
 *   - a handoff stage needs pack tools       → AWAITING_HANDOFF (directive)
 *   - a user decision is needed              → asked inline via elicitation,
 *                                              or AWAITING_ANSWER (fallback)
 *   - a guardrail blocks                     → BLOCKED_* states
 *   - the playbook finishes                  → COMPLETE (+ packs released)
 *
 * Every boundary crossing is token-metered and every transition persisted,
 * so a session survives compaction/restarts with zero rework.
 *
 * @module agentic/CSPlaybookEngine
 */

import { MCPToolContext } from '../types/CSMCPTypes';
import { CSSDLCCatalog } from './CSSDLCCatalog';
import { CSPlaybooks } from './CSPlaybooks';
import { CSSessionStore } from './CSSessionStore';
import { CSGuardrailEngine, GUARDRAIL_LIMITS } from './CSGuardrailEngine';
import { CSInteract } from './CSInteract';
import { CSToolPacks } from './CSToolPacks';
import {
    AgenticToolResult,
    SessionRecord,
    StageContext,
    StageOutcome,
} from './types';

export interface AdvanceInputs {
    submission?: unknown;
    handoffReport?: Record<string, unknown>;
    answers?: Record<string, string | number | boolean>;
}

export class CSPlaybookEngine {
    private readonly packs: CSToolPacks;

    constructor(packs: CSToolPacks) {
        this.packs = packs;
    }

    // ------------------------------------------------------------------
    // Main stepper
    // ------------------------------------------------------------------

    public async advance(
        session: SessionRecord,
        mcp: MCPToolContext,
        workspaceRoot: string,
        inputs: AdvanceInputs = {},
    ): Promise<AgenticToolResult> {
        const modeDef = CSSDLCCatalog.get(session.mode);
        if (!modeDef) {
            return this.blocked(session, `Unknown mode "${session.mode}" — session cannot continue.`);
        }

        let pending: AdvanceInputs = { ...inputs };

        // Guard: an outstanding envelope/handoff/question must be satisfied
        // by the matching input, not skipped by a bare advance.
        if (session.state === 'AWAITING_SUBMIT' && pending.submission === undefined) {
            return this.reEmit(session);
        }
        if (session.state === 'AWAITING_HANDOFF' && pending.handoffReport === undefined) {
            return this.reEmit(session);
        }
        if (session.state === 'AWAITING_ANSWER' && pending.answers === undefined) {
            return this.reEmit(session);
        }

        session.state = 'ACTIVE';

        // Auto-chain loop.
        for (;;) {
            const budget = CSGuardrailEngine.checkBudget(session);
            if (!budget.ok) {
                session.blockedReason = budget.reason;
                CSSessionStore.transition(session, 'BLOCKED_BUDGET', budget.reason);
                return {
                    ok: false,
                    sessionId: session.sessionId,
                    mode: session.mode,
                    state: session.state,
                    action: 'stop',
                    blockedReason:
                        `${budget.reason}. To continue anyway, re-invoke cs_ai_auto_assist with ` +
                        `{ action: "extend_budget", sessionId: "${session.sessionId}" } — ` +
                        'ask the user first; extending spends more of their AI credits.',
                    statusPath: CSSessionStore.statusPath(session),
                    usage: this.usageView(session),
                };
            }
            const steps = CSGuardrailEngine.checkStepLimit(session);
            if (!steps.ok) {
                return this.blocked(session, steps.reason ?? 'step limit exceeded');
            }

            const stageId = modeDef.stages[session.stageIndex];
            if (stageId === undefined) {
                // Ran off the end without an explicit finalize — treat as done.
                CSSessionStore.transition(session, 'COMPLETE');
                this.releasePacks(session, modeDef.toolPacks);
                return this.done(session, undefined, 'playbook complete');
            }

            const stageDef = CSPlaybooks.getStage(stageId);
            if (!stageDef) {
                return this.blocked(session, `Stage "${stageId}" is not implemented.`);
            }

            const ctx: StageContext = {
                session,
                mcp,
                workspaceRoot,
                writeArtifact: (rel, content) => {
                    const abs = CSSessionStore.writeArtifact(session, rel, content);
                    CSGuardrailEngine.recordTokens(session, Math.min(content.length, 20_000));
                    return abs;
                },
                recordTokens: (chars) => CSGuardrailEngine.recordTokens(session, chars),
                submission: pending.submission,
                handoffReport: pending.handoffReport,
                answers: pending.answers,
            };
            // Pending payloads are consumed by exactly one stage invocation.
            pending = {};

            session.stepsExecuted += 1;

            let outcome: StageOutcome;
            try {
                outcome = await stageDef.run(ctx);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return this.blocked(session, `Stage "${stageId}" failed: ${message}`);
            }

            session.stageLog.push({
                stageId,
                status: outcome.status,
                summary: outcome.summary,
                at: new Date().toISOString(),
            });
            CSSessionStore.appendTimeline(session, {
                event: 'stage',
                stageId,
                status: outcome.status,
                summary: outcome.summary,
            });

            switch (outcome.status) {
                case 'complete': {
                    session.stageIndex += 1;
                    session.pendingStageId = undefined;
                    session.pendingEnvelope = undefined;
                    session.pendingHandoff = undefined;
                    session.pendingQuestion = undefined;
                    session.submitRetries = 0;
                    session.submitBuffer = undefined;
                    CSSessionStore.save(session);
                    continue; // auto-chain to the next stage
                }

                case 'envelope': {
                    session.pendingStageId = stageId;
                    session.pendingEnvelope = outcome.envelope;
                    CSSessionStore.transition(session, 'AWAITING_SUBMIT');
                    return {
                        ok: true,
                        sessionId: session.sessionId,
                        mode: session.mode,
                        state: session.state,
                        action: 'fulfil_envelope',
                        envelope: outcome.envelope,
                        note: outcome.summary,
                        statusPath: CSSessionStore.statusPath(session),
                        usage: this.usageView(session),
                    };
                }

                case 'handoff': {
                    session.pendingStageId = stageId;
                    session.pendingHandoff = outcome.handoff;
                    // Stage-level progressive disclosure: packs this handoff
                    // needs come into scope only now.
                    if (outcome.handoff?.packs?.length) {
                        this.activatePacksForSession(session, outcome.handoff.packs);
                    }
                    CSSessionStore.transition(session, 'AWAITING_HANDOFF');
                    return {
                        ok: true,
                        sessionId: session.sessionId,
                        mode: session.mode,
                        state: session.state,
                        action: 'call_tool',
                        handoff: outcome.handoff,
                        nextSuggestedTool: outcome.handoff?.nextSuggestedTool,
                        nextSuggestedArgs: outcome.handoff?.nextSuggestedArgs,
                        note: outcome.summary,
                        statusPath: CSSessionStore.statusPath(session),
                        usage: this.usageView(session),
                    };
                }

                case 'question': {
                    const question = outcome.question!;
                    // Try native elicitation first — zero agent round-trips.
                    const asked = await CSInteract.form(mcp, question.message, question.fields);
                    if (asked.kind === 'answers') {
                        pending = { answers: asked.answers };
                        CSSessionStore.save(session);
                        continue; // re-run the same stage with answers
                    }
                    if (asked.kind === 'declined') {
                        return this.blocked(session, 'User declined the requested input.');
                    }
                    session.pendingStageId = stageId;
                    session.pendingQuestion = question;
                    CSSessionStore.transition(session, 'AWAITING_ANSWER');
                    return {
                        ok: true,
                        sessionId: session.sessionId,
                        mode: session.mode,
                        state: session.state,
                        action: 'ask_user',
                        question,
                        note: CSInteract.questionText(question),
                        statusPath: CSSessionStore.statusPath(session),
                        usage: this.usageView(session),
                    };
                }

                case 'blocked': {
                    return this.blocked(session, outcome.blockedReason ?? outcome.summary);
                }

                case 'finished': {
                    CSSessionStore.transition(session, 'COMPLETE');
                    this.releasePacks(session, modeDef.toolPacks);
                    return this.done(session, outcome.reportPath, outcome.summary);
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Re-emit an outstanding decision (idempotent resume)
    // ------------------------------------------------------------------

    public reEmit(session: SessionRecord): AgenticToolResult {
        const base = {
            ok: true,
            sessionId: session.sessionId,
            mode: session.mode,
            state: session.state,
            statusPath: CSSessionStore.statusPath(session),
            usage: this.usageView(session),
        };
        if (session.state === 'AWAITING_SUBMIT' && session.pendingEnvelope) {
            return {
                ...base,
                action: 'fulfil_envelope',
                envelope: session.pendingEnvelope,
                note: `envelope "${session.pendingEnvelope.task}" is still outstanding — fulfil it via csaa_submit`,
            };
        }
        if (session.state === 'AWAITING_HANDOFF' && session.pendingHandoff) {
            return {
                ...base,
                action: 'call_tool',
                handoff: session.pendingHandoff,
                nextSuggestedTool: session.pendingHandoff.nextSuggestedTool,
                nextSuggestedArgs: session.pendingHandoff.nextSuggestedArgs,
                note: `handoff "${session.pendingHandoff.handoffId}" is still outstanding — finish it, then csaa_advance with the report`,
            };
        }
        if (session.state === 'AWAITING_ANSWER' && session.pendingQuestion) {
            return {
                ...base,
                action: 'ask_user',
                question: session.pendingQuestion,
                note: CSInteract.questionText(session.pendingQuestion),
            };
        }
        if (session.state === 'COMPLETE') {
            return this.done(session, undefined, 'session already complete');
        }
        if (session.state === 'BLOCKED_BUDGET' || session.state === 'BLOCKED_NEED_HUMAN') {
            return {
                ...base,
                ok: false,
                action: 'stop',
                blockedReason: session.blockedReason,
            };
        }
        return { ...base, action: 'advance', note: 'session active — call csaa_advance' };
    }

    // ------------------------------------------------------------------
    // Submission path (csaa_submit)
    // ------------------------------------------------------------------

    public async submit(
        session: SessionRecord,
        mcp: MCPToolContext,
        workspaceRoot: string,
        payload: unknown,
    ): Promise<AgenticToolResult> {
        const envelope = session.pendingEnvelope;
        if (session.state !== 'AWAITING_SUBMIT' || !envelope) {
            return {
                ok: false,
                sessionId: session.sessionId,
                mode: session.mode,
                state: session.state,
                action: session.state === 'ACTIVE' ? 'advance' : 'stop',
                blockedReason: 'No envelope is outstanding for this session.',
            };
        }

        CSGuardrailEngine.recordTokens(session, JSON.stringify(payload ?? '').length);

        const gate = CSGuardrailEngine.validateSubmission(payload, envelope.responseSchema);
        if (!gate.ok) {
            session.submitRetries += 1;
            CSSessionStore.appendTimeline(session, {
                event: 'submit_rejected',
                retries: session.submitRetries,
                errors: gate.errors.slice(0, 10),
            });
            if (session.submitRetries >= GUARDRAIL_LIMITS.maxSubmitRetries) {
                return this.blocked(
                    session,
                    `Envelope "${envelope.task}" failed schema validation ${session.submitRetries} times. ` +
                        `Last errors: ${gate.errors.slice(0, 5).join('; ')}`,
                );
            }
            CSSessionStore.save(session);
            return {
                ok: false,
                sessionId: session.sessionId,
                mode: session.mode,
                state: session.state,
                action: 'fulfil_envelope',
                envelope,
                blockedReason:
                    `Schema validation failed (attempt ${session.submitRetries}/${GUARDRAIL_LIMITS.maxSubmitRetries}). ` +
                    `Fix these and re-submit: ${gate.errors.slice(0, 8).join('; ')}`,
                usage: this.usageView(session),
            };
        }

        return this.advance(session, mcp, workspaceRoot, { submission: payload });
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /** Activate packs mid-session and record them for later release. */
    public activatePacksForSession(session: SessionRecord, packNames: string[]): void {
        const activated = new Set(session.activatedPacks ?? []);
        for (const name of packNames) {
            if (activated.has(name)) continue;
            const result = this.packs.activate(name);
            activated.add(name);
            CSSessionStore.appendTimeline(session, {
                event: 'pack_activated',
                pack: name,
                toolsExposed: result.activated.length,
            });
        }
        session.activatedPacks = Array.from(activated);
    }

    public releasePacks(session: SessionRecord, packNames: string[]): void {
        if (session.packsReleased) return;
        const all = new Set([...packNames, ...(session.activatedPacks ?? [])]);
        this.packs.releaseAll(Array.from(all));
        session.packsReleased = true;
        CSSessionStore.save(session);
    }

    private blocked(session: SessionRecord, reason: string): AgenticToolResult {
        session.blockedReason = reason;
        CSSessionStore.transition(session, 'BLOCKED_NEED_HUMAN', reason);
        return {
            ok: false,
            sessionId: session.sessionId,
            mode: session.mode,
            state: session.state,
            action: 'stop',
            blockedReason: reason,
            statusPath: CSSessionStore.statusPath(session),
            usage: this.usageView(session),
        };
    }

    private done(
        session: SessionRecord,
        reportPath: string | undefined,
        note: string,
    ): AgenticToolResult {
        const report =
            reportPath ?? session.artifacts.find((a) => a.endsWith('final-report.md'));
        return {
            ok: true,
            sessionId: session.sessionId,
            mode: session.mode,
            state: session.state,
            action: 'done',
            reportPath: report,
            note,
            statusPath: CSSessionStore.statusPath(session),
            usage: this.usageView(session),
        };
    }

    private usageView(
        session: SessionRecord,
    ): Pick<SessionRecord['usage'], 'estimatedTokens' | 'toolCalls' | 'estimatedCostUsd'> {
        return {
            estimatedTokens: session.usage.estimatedTokens,
            toolCalls: session.usage.toolCalls,
            estimatedCostUsd: Math.round(session.usage.estimatedCostUsd * 100) / 100,
        };
    }
}
