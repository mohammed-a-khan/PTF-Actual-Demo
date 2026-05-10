/**
 * CS-AI-Auto-Assist — Master Tool (rebuild scaffold)
 *
 * Defines the `cs_ai_auto_assist` MCP tool: the single entry point referenced
 * by the `cs-ai-auto-assist` Copilot agent prompt. Returns a run identifier
 * plus the next-step instruction so the agent composes the rebuild's primitive
 * tools (M2–M10) in sequence.
 *
 * **Rebuild milestone M1.** The previous monolithic `dispatchMode` body has
 * been removed along with the stub-ware generators (`legacy_transform`,
 * IR converters, six composers, five mode handlers, the deprecated Copilot
 * delegate). Generation now flows through a toolbox of narrow primitives
 * orchestrated by the agent prompt — see `.github/agents/cs-ai-auto-assist.md`.
 *
 * What this tool still does:
 *   - sanitize the inbound prompt (reject real secrets, pass test data)
 *   - classify the input via `CSIntentRouter` (regex + structured-field
 *     extraction; no LLM)
 *   - apply non-blocking clarification (auto-defaults + LLM resolution
 *     before falling to user elicitation)
 *   - allocate a runId + return a structured `AgentRunResult` with the
 *     next-suggested-tool hint so the agent invokes the right primitive
 *
 * What it does NOT do anymore:
 *   - in-process generation (the deleted mode handlers used to do this)
 *   - execution gate / heal loop (now invoked by the agent via primitives)
 *   - ADO create-back (now invoked by the agent via primitives)
 *
 * Privacy-by-design: no domain, organization, or project-specific identifiers
 * appear in this file.
 *
 * @module agent-platform/CSAIAutoAssist
 */

import {
    MCPToolContext,
    MCPToolDefinition,
    MCPToolResult,
} from '../types/CSMCPTypes';
import {
    defineTool,
    CSMCPToolRegistry,
    MCPToolBuilder,
} from '../CSMCPToolRegistry';
import { CSIntentRouter } from './CSIntentRouter';
import { CSClarificationAgent } from './CSClarificationAgent';
import { CSPiiSanitizer } from './CSPiiSanitizer';
import { CSCostTelemetry } from './CSCostTelemetry';
import { CSRunContext } from './CSRunContext';
import { CSStatusWriter } from './CSStatusWriter';
import {
    AgentRunResult,
    ClarificationQuestion,
    ClassifiedInput,
    CostBudget,
} from './types';

// ============================================================================
// Helpers
// ============================================================================

/** Generate a stable run identifier. Format: `run_<epochMs>_<random>`. */
function newRunId(): string {
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Wrap an AgentRunResult into the standard MCP text-result shape with an
 * active-imperative summary line so Copilot's agent loop continues
 * productively rather than abandoning the tool on a "blocked"-style word.
 */
function jsonResult(data: unknown): MCPToolResult {
    const json = JSON.stringify(data, null, 2);
    const summary = buildActiveImperativeSummary(data);
    return {
        content: [{ type: 'text', text: `${summary}\n\n${json}` }],
        structuredContent: data as Record<string, unknown>,
    };
}

function buildActiveImperativeSummary(data: unknown): string {
    const r = data as Partial<AgentRunResult> | undefined;
    if (!r || typeof r !== 'object') return 'cs_ai_auto_assist: result available below.';
    if (r.state === 'READY') {
        return `Run ${r.runId ?? '?'} reached READY. ${r.testsPassed ?? 0} test(s) passed; trust ${r.trustScoreAvg ?? 0}.`;
    }
    if (r.nextSuggestedTool) {
        return `Call ${r.nextSuggestedTool} next with the runId in structuredContent.runId. ${r.blockedReason ?? ''}`.trim();
    }
    if (r.blockedReason) {
        return r.blockedReason;
    }
    return `Run ${r.runId ?? '?'} initialised; agent prompt should follow the primitive sequence.`;
}

function defaultBudget(input: Record<string, unknown> | undefined): CostBudget {
    const u = input?.budget as Partial<CostBudget> | undefined;
    return {
        maxTokens: typeof u?.maxTokens === 'number' ? u.maxTokens : 500_000,
        maxWallClockMs: typeof u?.maxWallClockMs === 'number' ? u.maxWallClockMs : 30 * 60 * 1000,
        maxCostUsd: typeof u?.maxCostUsd === 'number' ? u.maxCostUsd : 5.0,
    };
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Execute the M1 scaffold handler. Steps:
 *   1. Sanitise inbound prompt (reject real secrets).
 *   2. Classify via CSIntentRouter (regex + structured-field extraction).
 *   3. Compute non-blocking clarification questions (auto-default Tier-1).
 *   4. Allocate runId + telemetry budget.
 *   5. Return structured AgentRunResult with nextSuggestedTool hint that
 *      directs the agent to the appropriate first primitive.
 *
 * The runId returned here is the per-run artefact folder key under
 * `Agent-Processing/<ts>_<runId>/` once M2 (CSRunContext) lands.
 */
async function execute(
    input: Record<string, unknown>,
    context: MCPToolContext,
): Promise<MCPToolResult> {
    const startedAt = new Date();
    const runId = newRunId();
    const rawInput = String(input.input ?? '').trim();

    // -- Sanitise --------------------------------------------------------------
    const sanitised = CSPiiSanitizer.sanitize(rawInput, 'reject_secrets_only');
    if (sanitised.decision === 'REJECTED') {
        return jsonResult({
            state: 'BLOCKED_NEED_INPUT',
            runId,
            mode: 'unknown',
            startedAt: startedAt.toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt.getTime(),
            tokensTotal: 0,
            costUsd: 0,
            testsGenerated: 0,
            testsPassed: 0,
            trustScoreAvg: 0,
            filesCreated: [],
            blockedReason:
                'remove the suspected secret from your prompt before re-invoking. ' +
                'Reference secrets via {config:KEY} placeholders that resolve from your env file at runtime, ' +
                'never paste literal tokens / passwords into the prompt.',
            nextStepNeeded: false,
        } satisfies AgentRunResult);
    }

    // -- Classify --------------------------------------------------------------
    const classified: ClassifiedInput = CSIntentRouter.classify(
        sanitised.cleaned ?? rawInput,
    );

    // -- Compute clarification questions (non-blocking; auto-defaults applied) -
    // CSClarificationAgent.computeMissingFields auto-applies suggestedDefault
    // for Tier-1 questions and demotes universal questions; the only items
    // that come back here are genuine Tier-1-required fields without defaults.
    const missing: ClarificationQuestion[] =
        CSClarificationAgent.computeMissingFields(classified);
    const tier1Blockers = missing.filter((q) => q.tier === 1 && q.required);

    // -- Telemetry budget ------------------------------------------------------
    const budget = defaultBudget(input);
    const telemetry = new CSCostTelemetry(runId, budget);

    // -- Run context — creates Agent-Processing/<ts>_<runId>/ folder ----------
    const workspaceRoot =
        typeof input.workspaceRoot === 'string' && input.workspaceRoot
            ? input.workspaceRoot
            : context.server?.workingDirectory ?? process.cwd();
    const runCtx = CSRunContext.getOrCreate(runId, {
        workspaceRoot,
        inputSummary: rawInput.slice(0, 200),
    });
    runCtx.startPhase('intake');
    runCtx.writePhaseArtifact('intake', 'classified.json', JSON.stringify({
        mode: classified.mode,
        confidence: classified.confidence,
        extractedFields: classified.extractedFields,
    }, null, 2));
    runCtx.writePhaseArtifact('intake', 'input.txt', rawInput);
    runCtx.finishPhase('intake', tier1Blockers.length > 0 ? 'blocked_user' : 'done',
        tier1Blockers.length > 0
            ? { reason: `missing Tier-1 fields: ${tier1Blockers.map((q) => q.field).join(', ')}` }
            : undefined);
    CSStatusWriter.write(runCtx);

    // -- Build result ----------------------------------------------------------
    const result: AgentRunResult = {
        state: tier1Blockers.length > 0 ? 'BLOCKED_NEED_INPUT' : 'RUNNING',
        runId,
        mode: classified.mode,
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        tokensTotal: 0,
        costUsd: 0,
        testsGenerated: 0,
        testsPassed: 0,
        trustScoreAvg: 0,
        filesCreated: [],
        blockedReason:
            tier1Blockers.length > 0
                ? `supply the missing Tier-1 fields and re-invoke: ${tier1Blockers.map((q) => q.field).join(', ')}`
                : undefined,
        clarificationsNeeded: tier1Blockers.length > 0 ? tier1Blockers : undefined,
        nextStepNeeded: tier1Blockers.length === 0,
        nextSuggestedTool: tier1Blockers.length === 0 ? 'csaa_discover' : 'cs_ai_auto_assist',
        nextSuggestedArgs:
            tier1Blockers.length === 0
                ? {
                      runId,
                      rootPath: classified.extractedFields.path
                          ?? classified.extractedFields.projectRoot
                          ?? workspaceRoot,
                      entryFile: classified.extractedFields.path,
                  }
                : undefined,
    };

    void telemetry; // M2+ wires telemetry into the run-context folder
    return jsonResult(result);
}

// ============================================================================
// Tool Definition
// ============================================================================

const csAiAutoAssistTool: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('cs_ai_auto_assist')
    .title('CS-AI-Auto-Assist — Master')
    .description(
        'Master entry point for CS-AI-Auto-Assist. Classifies your input ' +
            '(legacy file path / ADO id / app URL / requirements doc / source path / chat) ' +
            'and returns a runId plus the next primitive tool the agent should call. ' +
            'The agent then composes the rebuild primitives (csaa_run_init, csaa_discover, ' +
            'csaa_analyze, csaa_plan, csaa_translate, csaa_audit, csaa_write, csaa_execute, ' +
            'csaa_verify, csaa_publish) per the workflow in the cs-ai-auto-assist agent prompt.',
    )
    .category('multiagent')
    .stringParam('input', 'User input — any format', { required: true })
    .stringParam('mode', 'Optional explicit mode override (skips classification)')
    .objectParam('budget', 'Optional CostBudget override')
    .handler(async (params: Record<string, unknown>, ctx: MCPToolContext) =>
        execute(params, ctx),
    )
    .build();

export const csAiAutoAssistTools: MCPToolDefinition[] = [csAiAutoAssistTool];
