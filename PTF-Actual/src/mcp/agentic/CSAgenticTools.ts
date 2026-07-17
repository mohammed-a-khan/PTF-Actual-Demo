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
import { CSGuardrailEngine } from './CSGuardrailEngine';
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

    // Collect missing required fields — natively when possible.
    if (validated.missing.length > 0) {
        const asked = await CSInteract.form(
            context,
            `${modeDef.title} — please provide:`,
            validated.missing,
        );
        if (asked.kind === 'answers') {
            const merged = { ...rawInputs, ...asked.answers };
            return startSession(modeDef, merged, context);
        }
        if (asked.kind === 'declined') {
            return {
                ok: false,
                mode: modeDef.mode,
                action: 'stop',
                blockedReason: 'User declined to provide the required inputs.',
            };
        }
        return {
            ok: true,
            mode: modeDef.mode,
            action: 'ask_user',
            question: {
                questionId: 'collect_inputs',
                message: `To run "${modeDef.title}" I need:`,
                fields: validated.missing,
            },
            note:
                'Ask the user for these values, then re-call cs_ai_auto_assist with ' +
                `{ mode: "${modeDef.mode}", inputs: { ...provided values... } }.`,
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
                CSGuardrailEngine.extendBudget(session);
                session.blockedReason = undefined;
                CSSessionStore.transition(session, 'ACTIVE', 'budget extended by user');
                return jsonResult(await engineRef.advance(session, context, root));
            }

            // resume (explicit or implicit via sessionId). Re-activate packs
            // idempotently — repeated resumes must not inflate ref counts.
            const modeDef = CSSDLCCatalog.get(session.mode);
            if (modeDef && !session.packsReleased) {
                const needed = session.activatedPacks?.length
                    ? session.activatedPacks
                    : modeDef.toolPacks;
                for (const p of needed) {
                    if (!packsRef.isActive(p)) packsRef.activate(p);
                }
            }
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
            // Native dropdown first; text menu fallback.
            const picked = await CSInteract.pick(
                context,
                'CS AI Auto-Assist — what do you want to do?',
                CSSDLCCatalog.list().map((m) => ({
                    value: m.mode,
                    title: m.title,
                    description: m.summary,
                })),
            );
            if (picked.kind === 'picked') {
                mode = picked.value;
            } else if (picked.kind === 'declined') {
                return jsonResult({
                    ok: true,
                    action: 'done',
                    note: 'User dismissed the menu. Nothing started.',
                });
            } else {
                const menu = CSSDLCCatalog.modeMenu();
                return jsonResult({
                    ok: true,
                    action: 'show_menu',
                    menu,
                    note:
                        'Show this menu to the user EXACTLY as rendered by the menuText below, ' +
                        'then re-call cs_ai_auto_assist with { mode: "<their choice>" }.\n\n' +
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

        // With elicitation, collect the full input form up-front in ONE dialog.
        if (Object.keys(rawInputs).length === 0 && modeDef.inputs.length > 0 && CSInteract.supported(context)) {
            const asked = await CSInteract.form(context, `${modeDef.title} — inputs:`, modeDef.inputs);
            if (asked.kind === 'answers') {
                return jsonResult(await startSession(modeDef, asked.answers, context));
            }
            if (asked.kind === 'declined') {
                return jsonResult({
                    ok: true,
                    mode: modeDef.mode,
                    action: 'done',
                    note: 'User dismissed the input form. Nothing started.',
                });
            }
        }

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
        const { engine: engineRef } = requireEngine();
        const session = loadSession(params.sessionId, context);
        if (!session) return jsonResult(NO_SESSION);
        meter(session, params);

        const report = params.report as Record<string, unknown> | undefined;
        const answers = params.answers as Record<string, string | number | boolean> | undefined;

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
        const { engine: engineRef } = requireEngine();
        const session = loadSession(params.sessionId, context);
        if (!session) return jsonResult(NO_SESSION);
        meter(session, params);

        const chunk = String(params.payload ?? '');
        const isPart = params.part === true;
        const isFinal = params.final !== false && !isPart;

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
                const result = packsRef.activate(pack);
                return jsonResult({
                    ok: true,
                    action: 'advance',
                    note: result.alreadyActive
                        ? `pack "${pack}" was already active`
                        : `pack "${pack}" activated: ${result.activated.length} tools now available`,
                } as unknown as Record<string, unknown>);
            }
            packsRef.release(pack);
            return jsonResult({
                ok: true,
                action: 'advance',
                note: `pack "${pack}" released`,
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
