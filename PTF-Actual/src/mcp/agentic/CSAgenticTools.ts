/**
 * Agentic SDLC Platform — Meta-Tools
 *
 * The ENTIRE startup tool surface of the agentic server profile. Five tools:
 *
 *   cs_ai_auto_assist  front door: SDLC menu → inputs → session → first step
 *   csaa_advance       run playbook stages / hand back handoff reports+answers
 *   csaa_submit        validated hand-back of cognitive envelope JSON
 *   csaa_status        session snapshot / list / resume
 *   csaa_toolpack      progressive disclosure: list/activate/release packs
 *
 * Everything else (240+ concrete tools) loads lazily through capability
 * packs when — and only when — a mode needs them.
 *
 * @module agentic/CSAgenticTools
 */

import { defineTool } from '../CSMCPToolRegistry';
import { CSMCPToolRegistry } from '../CSMCPToolRegistry';
import { MCPToolContext, MCPToolDefinition, MCPToolResult } from '../types/CSMCPTypes';

import { CSSDLCCatalog } from './CSSDLCCatalog';
import { CSSessionStore } from './CSSessionStore';
import { CSGuardrailEngine, GUARDRAIL_LIMITS } from './CSGuardrailEngine';
import { CSInteract } from './CSInteract';
import { CSPlaybookEngine } from './CSPlaybookEngine';
import { CSToolPacks } from './CSToolPacks';
import { AgenticToolResult, ModeDefinition, SessionRecord } from './types';

// ============================================================================
// Wiring
// ============================================================================

let packs: CSToolPacks | null = null;
let engine: CSPlaybookEngine | null = null;

function requireEngine(): { packs: CSToolPacks; engine: CSPlaybookEngine } {
    if (!packs || !engine) {
        throw new Error(
            'Agentic tools are not initialized — call registerAgenticTools(registry, notifyToolsChanged) first.',
        );
    }
    return { packs, engine };
}

function workspaceRoot(context: MCPToolContext): string {
    return context.server.workingDirectory || process.cwd();
}

function jsonResult(data: AgenticToolResult | Record<string, unknown>): MCPToolResult {
    return {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: data as Record<string, unknown>,
        isError: (data as AgenticToolResult).ok === false,
    };
}

function meter(session: SessionRecord, params: Record<string, unknown>): void {
    CSGuardrailEngine.recordToolCall(session);
    CSGuardrailEngine.recordTokens(session, JSON.stringify(params).length);
}

function loadSession(
    sessionId: unknown,
    context: MCPToolContext,
): SessionRecord | null {
    const id = String(sessionId ?? '').trim();
    if (!id) return null;
    return CSSessionStore.load(id, workspaceRoot(context));
}

/**
 * Re-take this session's pack holds (idempotent per owner). Called on every
 * session-loading path — resume, csaa_advance, csaa_submit — so that after a
 * server restart the natural next call finds its pack tools registered again,
 * not just the cs_ai_auto_assist resume branch.
 */
function ensureSessionPacks(session: SessionRecord, packsRef: CSToolPacks): void {
    if (session.state === 'CANCELLED' || session.state === 'COMPLETE') return;
    const modeDef = CSSDLCCatalog.get(session.mode);
    if (!modeDef) return;
    const needed = new Set<string>([
        ...modeDef.toolPacks,
        ...(session.activatedPacks ?? []),
    ]);
    for (const p of needed) packsRef.activate(p, session.sessionId);
    if (session.packsReleased && needed.size > 0) session.packsReleased = false;
}

const NO_SESSION: AgenticToolResult = {
    ok: false,
    action: 'stop',
    blockedReason:
        'Unknown or missing sessionId. Call cs_ai_auto_assist to start a session, ' +
        'or csaa_status {action:"list"} to find a resumable one.',
};

// ============================================================================
// Session bootstrap (shared by elicitation + fallback paths)
// ============================================================================

async function startSession(
    modeDef: ModeDefinition,
    rawInputs: Record<string, unknown>,
    context: MCPToolContext,
): Promise<AgenticToolResult> {
    const { engine: engineRef } = requireEngine();
    const root = workspaceRoot(context);

    const validated = CSSDLCCatalog.validateInputs(modeDef, rawInputs);
    if (validated.errors.length > 0) {
        return {
            ok: false,
            mode: modeDef.mode,
            action: 'ask_user',
            question: {
                questionId: 'fix_inputs',
                message: `Some inputs are invalid: ${validated.errors.join('; ')}`,
                fields: modeDef.inputs,
            },
            blockedReason: validated.errors.join('; '),
        };
    }

    // Collect the not-yet-provided inputs. Prefer ONE consolidated native
    // dialog (the fancy form) via the single-dialog lock; on busy / dismissed /
    // unsupported fall back to a single text question. Either way it is exactly
    // ONE prompt — never the cascading duplicate boxes.
    if (validated.missing.length > 0) {
        const toAsk = modeDef.inputs.filter((f) => rawInputs[f.id] === undefined || rawInputs[f.id] === '');
        const dialogFields = toAsk.length > 0 ? toAsk : validated.missing;
        const asked = await CSInteract.form(context, `${modeDef.title} — inputs:`, dialogFields);
        if (asked.kind === 'answers') {
            return startSession(modeDef, { ...rawInputs, ...asked.answers }, context);
        }
        // busy / cancelled / declined / unsupported → single text question, wait.
        return {
            ok: true,
            mode: modeDef.mode,
            action: 'ask_user',
            question: {
                questionId: 'collect_inputs',
                message: `To run "${modeDef.title}" I need the following — please provide them (I will wait):`,
                fields: validated.missing,
            },
            note:
                'Relay these fields to the user in ONE message and WAIT for their values — do not ' +
                'proceed, assume defaults, or ask again while waiting. Then re-call cs_ai_auto_assist ' +
                `once with { mode: "${modeDef.mode}", inputs: { ...all provided values... } }.`,
        };
    }

    // Guardrail: PII/secret intake scan on all collected values.
    const intake = CSGuardrailEngine.intake(validated.values);
    if (!intake.ok) {
        return { ok: false, mode: modeDef.mode, action: 'stop', blockedReason: intake.reason };
    }

    // Config preflight: tell the user what infrastructure is missing BEFORE
    // any work (and paid tokens) is spent. A BLOCKER stops the session.
    const preflight = CSGuardrailEngine.preflight(modeDef.mode, intake.cleaned, root);
    const blocker = preflight.find((w) => w.startsWith('BLOCKER:'));
    if (blocker) {
        return {
            ok: false,
            mode: modeDef.mode,
            action: 'stop',
            blockedReason: blocker.replace(/^BLOCKER:\s*/, ''),
        };
    }

    const session = CSSessionStore.create(modeDef.mode, intake.cleaned, root);
    if (preflight.length > 0) {
        CSSessionStore.appendTimeline(session, { event: 'preflight', warnings: preflight });
    }
    meter(session, validated.values as Record<string, unknown>);

    // Progressive disclosure: only now do this mode's packs come into scope.
    // (Handoff stages can activate further packs later, even leaner.)
    if (modeDef.toolPacks.length > 0) {
        engineRef.activatePacksForSession(session, modeDef.toolPacks);
    }

    const result = await engineRef.advance(session, context, root);
    if (preflight.length > 0) {
        const notes = preflight.map((w) => w.replace(/^NOTE:\s*/, '')).join(' ');
        result.note = result.note ? `${notes}\n${result.note}` : notes;
    }
    return result;
}

// ============================================================================
// Tool 1 — cs_ai_auto_assist (front door)
// ============================================================================

const frontDoorTool = defineTool()
    .name('cs_ai_auto_assist')
    .title('CS AI Auto-Assist')
    .description(
        'Single entry point for the complete test SDLC: plan, analyze, design, ' +
            'author, migrate, review, PR review, run, heal, triage, regression, ' +
            'performance, audit, accessibility, security, ADO test plans, ' +
            'release go/no-go, load testing. Call with NO arguments to let the ' +
            'user pick a mode (native dropdown when supported, else relay the ' +
            'returned menu verbatim). Then follow the returned `action` field ' +
            'exactly. Users provide inputs — never prompts.',
    )
    .category('multiagent')
    .stringParam('mode', 'SDLC mode id (from the menu). Omit to show the menu.')
    .objectParam('inputs', 'Mode inputs keyed by field id (from the menu/question).')
    .stringParam('sessionId', 'Existing session to resume / act on.')
    .stringParam('action', 'Optional: menu | start | resume | cancel | extend_budget', {
        enum: ['menu', 'start', 'resume', 'cancel', 'extend_budget'],
    })
    .handler(async (params, context): Promise<MCPToolResult> => {
        const { packs: packsRef, engine: engineRef } = requireEngine();
        const root = workspaceRoot(context);
        const action = String(params.action ?? '').trim();

        // ---- session actions -------------------------------------------
        if (action === 'cancel' || action === 'extend_budget' || action === 'resume' || params.sessionId) {
            const session = loadSession(params.sessionId, context);
            if (!session) return jsonResult(NO_SESSION);
            meter(session, params);

            if (action === 'cancel') {
                if (session.state === 'CANCELLED' || session.state === 'COMPLETE') {
                    return jsonResult({
                        ok: true,
                        sessionId: session.sessionId,
                        state: session.state,
                        action: 'done',
                        note: `session already ${session.state}`,
                    });
                }
                CSSessionStore.transition(session, 'CANCELLED', 'cancelled by user');
                const modeDef = CSSDLCCatalog.get(session.mode);
                if (modeDef) engineRef.releasePacks(session, modeDef.toolPacks);
                return jsonResult({
                    ok: true,
                    sessionId: session.sessionId,
                    state: session.state,
                    action: 'done',
                    note: 'session cancelled',
                });
            }

            if (action === 'extend_budget') {
                // Terminal sessions are not resurrectable — an extend on a
                // cancelled session would re-run stages whose packs are gone.
                if (session.state === 'CANCELLED' || session.state === 'COMPLETE') {
                    return jsonResult({
                        ok: false,
                        sessionId: session.sessionId,
                        state: session.state,
                        action: 'stop',
                        blockedReason: `Session is ${session.state} — its budget cannot be extended. Start a new session.`,
                    });
                }
                const extended = CSGuardrailEngine.extendBudget(session);
                if (!extended.ok) {
                    return jsonResult({
                        ok: false,
                        sessionId: session.sessionId,
                        state: session.state,
                        action: 'stop',
                        blockedReason: extended.reason,
                    });
                }
                session.blockedReason = undefined;
                ensureSessionPacks(session, packsRef);
                CSSessionStore.transition(session, 'ACTIVE', 'budget extended by user');
                return jsonResult(await engineRef.advance(session, context, root));
            }

            // resume (explicit or implicit via sessionId). Owner-attributed
            // activation is idempotent per session, so repeated resumes are
            // safe and a post-restart resume reliably re-takes its packs.
            ensureSessionPacks(session, packsRef);
            CSSessionStore.save(session);
            return jsonResult(engineRef.reEmit(session));
        }

        // ---- mode selection --------------------------------------------
        let mode = String(params.mode ?? '').trim();
        if (mode && !CSSDLCCatalog.isMode(mode)) {
            const resolved = CSSDLCCatalog.resolveModeAnswer(mode);
            mode = resolved ?? '';
        }

        if (!mode) {
            // Fancy native dropdown when the host supports elicitation — but
            // ONE dialog at a time (CSInteract's lock), and a text-menu
            // fallback for busy / dismissed / unsupported so it never
            // dead-ends or cascades.
            const picked = await CSInteract.pick(
                context,
                'CS AI Auto-Assist — what do you want to do?',
                CSSDLCCatalog.list().map((m) => ({ value: m.mode, title: m.title, description: m.summary })),
            );
            if (picked.kind === 'picked') {
                mode = picked.value;
            } else {
                const menu = CSSDLCCatalog.modeMenu();
                return jsonResult({
                    ok: true,
                    action: 'show_menu',
                    menu,
                    note:
                        'Show this menu to the user EXACTLY as rendered by the menuText below, ' +
                        'then re-call cs_ai_auto_assist with { mode: "<their choice>" }. ' +
                        'Do NOT proceed until the user has chosen.\n\n' +
                        CSInteract.menuText(menu),
                });
            }
        }

        const modeDef = CSSDLCCatalog.get(mode);
        if (!modeDef) {
            return jsonResult({
                ok: false,
                action: 'show_menu',
                menu: CSSDLCCatalog.modeMenu(),
                blockedReason: `Unknown mode "${String(params.mode)}".`,
            });
        }

        const rawInputs = (params.inputs as Record<string, unknown>) ?? {};
        // Input collection is handled by startSession via the reliable ask_user
        // protocol — NO server-initiated form here (that was the cause of the
        // cascading duplicate input boxes on the Copilot/GPT route).
        return jsonResult(await startSession(modeDef, rawInputs, context));
    })
    .build();

// ============================================================================
// Tool 2 — csaa_advance
// ============================================================================

const advanceTool = defineTool()
    .name('csaa_advance')
    .title('CS AI Auto-Assist — Advance')
    .description(
        'Advance the active session. Call bare to continue; pass `report` to ' +
            'complete an outstanding handoff (shape defined by its reportSchema); ' +
            'pass `answers` to answer an outstanding question. Deterministic ' +
            'stages auto-chain server-side — keep calling until action is ' +
            '"done" or "stop".',
    )
    .category('multiagent')
    .stringParam('sessionId', 'Session to advance', { required: true })
    .objectParam('report', 'Completion report for the outstanding handoff.')
    .objectParam('answers', 'Answers for the outstanding question, keyed by field id.')
    .handler(async (params, context): Promise<MCPToolResult> => {
        const { engine: engineRef, packs: packsRef } = requireEngine();
        const session = loadSession(params.sessionId, context);
        if (!session) return jsonResult(NO_SESSION);
        meter(session, params);
        ensureSessionPacks(session, packsRef);

        const report = params.report as Record<string, unknown> | undefined;
        const answers = params.answers as Record<string, string | number | boolean> | undefined;

        // Validate answers against the outstanding question's contract —
        // enum answers must be one of the declared options, required fields
        // must be present. Off-menu strings would otherwise flow raw into
        // stage logic (e.g. an arbitrary suiteId).
        if (session.state === 'AWAITING_ANSWER' && answers && session.pendingQuestion) {
            const problems: string[] = [];
            for (const f of session.pendingQuestion.fields) {
                const v = answers[f.id];
                if (v === undefined || v === null || v === '') {
                    if (f.required && f.default === undefined) problems.push(`${f.id}: required`);
                    continue;
                }
                if (f.type === 'enum' && f.options && !f.options.includes(String(v))) {
                    problems.push(`${f.id}: "${String(v)}" must be one of ${f.options.join(', ')}`);
                }
            }
            if (problems.length > 0) {
                return jsonResult({
                    ok: false,
                    sessionId: session.sessionId,
                    state: session.state,
                    action: 'ask_user',
                    question: session.pendingQuestion,
                    blockedReason: `Answers failed validation: ${problems.join('; ')}`,
                });
            }
        }

        if (session.state === 'AWAITING_HANDOFF' && report && session.pendingHandoff) {
            const gate = CSGuardrailEngine.validateSubmission(
                report,
                session.pendingHandoff.reportSchema,
            );
            if (!gate.ok) {
                return jsonResult({
                    ok: false,
                    sessionId: session.sessionId,
                    state: session.state,
                    action: 'call_tool',
                    handoff: session.pendingHandoff,
                    blockedReason: `Handoff report failed validation: ${gate.errors.slice(0, 6).join('; ')}`,
                });
            }
        }

        return jsonResult(
            await engineRef.advance(session, context, workspaceRoot(context), {
                handoffReport: report,
                answers,
            }),
        );
    })
    .build();

// ============================================================================
// Tool 3 — csaa_submit
// ============================================================================

const submitTool = defineTool()
    .name('csaa_submit')
    .title('CS AI Auto-Assist — Submit envelope result')
    .description(
        'Hand back the JSON produced for the outstanding delegation envelope. ' +
            'Payload is schema-validated before anything is persisted; on ' +
            'rejection, fix the listed errors and re-submit (max 3 attempts). ' +
            'For large payloads send chunks with part:true, then final:true.',
    )
    .category('multiagent')
    .stringParam('sessionId', 'Session with the outstanding envelope', { required: true })
    .stringParam('payload', 'The JSON document (stringified) fulfilling the envelope.')
    .booleanParam('part', 'True when this call carries a non-final chunk.', { default: false })
    .booleanParam('final', 'True when the buffered payload is complete.', { default: true })
    .handler(async (params, context): Promise<MCPToolResult> => {
        const { engine: engineRef, packs: packsRef } = requireEngine();
        const session = loadSession(params.sessionId, context);
        if (!session) return jsonResult(NO_SESSION);
        meter(session, params);
        ensureSessionPacks(session, packsRef);

        const chunk = String(params.payload ?? '');
        const isPart = params.part === true;
        const isFinal = params.final !== false && !isPart;

        // Chunk-path guards: the buffer is persisted into session.json, so an
        // unbounded stream would balloon every save; and buffering must not
        // become a budget-free channel.
        const projected = (session.submitBuffer?.length ?? 0) + chunk.length;
        if (projected > GUARDRAIL_LIMITS.maxSubmitBufferChars) {
            session.submitBuffer = undefined;
            CSSessionStore.save(session);
            return jsonResult({
                ok: false,
                sessionId: session.sessionId,
                state: session.state,
                action: 'fulfil_envelope',
                envelope: session.pendingEnvelope,
                blockedReason:
                    `Chunked payload exceeded ${GUARDRAIL_LIMITS.maxSubmitBufferChars} chars — buffer discarded. ` +
                    'Produce a SMALLER payload that still satisfies the schema (summarize, do not enumerate).',
            });
        }
        const budget = CSGuardrailEngine.checkBudget(session);
        if (!budget.ok) {
            session.submitBuffer = undefined;
            CSSessionStore.save(session);
            return jsonResult({
                ok: false,
                sessionId: session.sessionId,
                state: session.state,
                action: 'stop',
                blockedReason: budget.reason,
            });
        }

        session.submitBuffer = (session.submitBuffer ?? '') + chunk;

        if (!isFinal) {
            CSSessionStore.save(session);
            return jsonResult({
                ok: true,
                sessionId: session.sessionId,
                state: session.state,
                action: 'fulfil_envelope',
                note: `chunk buffered (${session.submitBuffer.length} chars total) — send the rest, then final:true`,
            });
        }

        const full = session.submitBuffer;
        session.submitBuffer = undefined;

        let parsed: unknown;
        try {
            parsed = JSON.parse(full);
        } catch (error) {
            session.submitRetries += 1;
            CSSessionStore.save(session);
            // Same cap as schema failures — malformed JSON must not loop
            // until the token budget drains.
            if (session.submitRetries >= GUARDRAIL_LIMITS.maxSubmitRetries) {
                return jsonResult({
                    ok: false,
                    sessionId: session.sessionId,
                    state: session.state,
                    action: 'stop',
                    blockedReason: `Payload was invalid JSON ${session.submitRetries} times (max ${GUARDRAIL_LIMITS.maxSubmitRetries}) — session needs human review.`,
                });
            }
            return jsonResult({
                ok: false,
                sessionId: session.sessionId,
                state: session.state,
                action: 'fulfil_envelope',
                envelope: session.pendingEnvelope,
                blockedReason: `Payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            });
        }

        return jsonResult(
            await engineRef.submit(session, context, workspaceRoot(context), parsed),
        );
    })
    .build();

// ============================================================================
// Tool 4 — csaa_status
// ============================================================================

const statusTool = defineTool()
    .name('csaa_status')
    .title('CS AI Auto-Assist — Status')
    .description(
        'Inspect sessions. action:"list" enumerates recent sessions (for ' +
            'resume after a restart/compaction); default returns the given ' +
            'session\'s snapshot including its outstanding step.',
    )
    .category('multiagent')
    .readOnly()
    .stringParam('sessionId', 'Session to inspect.')
    .stringParam('action', 'get | list', { enum: ['get', 'list'] })
    .handler(async (params, context): Promise<MCPToolResult> => {
        const { engine: engineRef } = requireEngine();
        if (String(params.action ?? '') === 'list' || !params.sessionId) {
            return jsonResult({
                ok: true,
                action: 'advance',
                note: 'Recent sessions. Resume one with cs_ai_auto_assist { sessionId } or start fresh with no args.',
                sessions: CSSessionStore.list(workspaceRoot(context)),
            } as unknown as Record<string, unknown>);
        }
        const session = loadSession(params.sessionId, context);
        if (!session) return jsonResult(NO_SESSION);
        const view = engineRef.reEmit(session);
        return jsonResult({
            ...view,
            stageLog: session.stageLog,
            artifacts: session.artifacts,
            inputs: session.inputs,
        } as unknown as Record<string, unknown>);
    })
    .build();

// ============================================================================
// Tool 5 — csaa_toolpack
// ============================================================================

const toolpackTool = defineTool()
    .name('csaa_toolpack')
    .title('CS AI Auto-Assist — Tool packs')
    .description(
        'Progressive tool disclosure. action:"list" shows the capability packs ' +
            '(no schemas loaded); "activate"/"release" registers or removes a ' +
            'pack\'s tools and notifies the host. Only activate a pack when a ' +
            'handoff or the user genuinely needs it — a small tool context ' +
            'saves the user\'s AI credits.',
    )
    .category('multiagent')
    .stringParam('action', 'list | activate | release', {
        required: true,
        enum: ['list', 'activate', 'release'],
    })
    .stringParam('pack', 'Pack name (for activate/release).')
    .handler(async (params): Promise<MCPToolResult> => {
        const { packs: packsRef } = requireEngine();
        const action = String(params.action);
        if (action === 'list') {
            return jsonResult({ ok: true, action: 'advance', packs: packsRef.list() } as unknown as Record<string, unknown>);
        }
        const pack = String(params.pack ?? '').trim();
        try {
            if (action === 'activate') {
                // Attributed to the manual pseudo-owner so an explicit
                // release can undo it — it can never pin a pack forever
                // against session lifecycle, nor free a session's hold.
                const result = packsRef.activate(pack, CSToolPacks.MANUAL_OWNER);
                return jsonResult({
                    ok: true,
                    action: 'advance',
                    note: result.alreadyActive
                        ? `pack "${pack}" was already active`
                        : `pack "${pack}" activated: ${result.activated.length} tools now available`,
                } as unknown as Record<string, unknown>);
            }
            // Release drops only the manual hold. Packs held by live sessions
            // stay registered — report who still holds them.
            packsRef.release(pack, CSToolPacks.MANUAL_OWNER);
            const holders = packsRef.holdersOf(pack);
            return jsonResult({
                ok: true,
                action: 'advance',
                note:
                    holders.length > 0
                        ? `pack "${pack}" still held by session(s): ${holders.join(', ')} — tools remain registered`
                        : `pack "${pack}" released`,
            } as unknown as Record<string, unknown>);
        } catch (error) {
            return jsonResult({
                ok: false,
                action: 'stop',
                blockedReason: error instanceof Error ? error.message : String(error),
            });
        }
    })
    .build();

// ============================================================================
// Registration
// ============================================================================

export const agenticMetaTools: MCPToolDefinition[] = [
    frontDoorTool,
    advanceTool,
    submitTool,
    statusTool,
    toolpackTool,
];

/**
 * Wire the agentic platform into a registry. `notifyToolsChanged` must emit
 * `notifications/tools/list_changed` (the server provides this) so hosts
 * refresh after pack activation.
 */
export function registerAgenticTools(
    registry: CSMCPToolRegistry,
    notifyToolsChanged: () => void,
): void {
    packs = new CSToolPacks(registry, notifyToolsChanged);
    engine = new CSPlaybookEngine(packs);
    registry.registerTools(agenticMetaTools);
}
