/**
 * CS-AI-Auto-Assist — Master Tool
 *
 * Defines the `cs_ai_auto_assist` MCP tool: the single entry point for the
 * CS-AI-Auto-Assist platform. The handler orchestrates intent routing,
 * sanitization, clarification, mode dispatch, and the execution gate.
 * Generation logic is wired end-to-end (Phase 2-6.5). The execution gate,
 * sanitizer, telemetry, trust score, and ADO fetch cascade all run
 * end-to-end.
 *
 * Privacy-by-design: this file contains no domain, organization, or
 * project-specific identifiers.
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
import { CSExecutionGate, ExecutionGateResult } from './CSExecutionGate';
import { CSPiiSanitizer } from './CSPiiSanitizer';
import { CSCostTelemetry } from './CSCostTelemetry';
import { CSTrustScore } from './CSTrustScore';
import { CSAdoModeHandler } from './CSAdoModeHandler';
import { LiveAppContext } from './CSLiveAppContext';
import { CSLegacyModeHandler } from './CSLegacyModeHandler';
import { CSDocumentModeHandler } from './CSDocumentModeHandler';
import { CSSourceCodeModeHandler } from './CSSourceCodeModeHandler';
import { CSChatModeHandler } from './CSChatModeHandler';
import { CSAppUrlModeHandler } from './CSAppUrlModeHandler';
import { CSAdoCreateBackFlow } from './CSAdoCreateBackFlow';
import { CSHealLoop } from './CSHealLoop';
import { CSMigrationCache } from './CSMigrationCache';
import { CSPreGateAudit, PreGateAuditResult } from './CSPreGateAudit';
import { CSRunTrace } from './CSRunTrace';
import { GenerationResult } from './CSGenerationOrchestrator';
import { CSConfigurationManager } from '../../core/CSConfigurationManager';
import {
    AgentRunMode,
    AgentRunResult,
    AgentRunState,
    ClarificationQuestion,
    ClassifiedInput,
    CostBudget,
    JudgeVerdict,
    TrustScoreInputs,
} from './types';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a stable run identifier. Format: run_<epochMs>_<random>.
 */
function newRunId(): string {
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Wrap an AgentRunResult into the standard MCP text-result shape.
 *
 * The text content begins with an ACTIVE-IMPERATIVE summary derived from
 * the result state. This is deliberate: Copilot's agent loop reads the
 * tool result as text and decides whether to call again or stop. Words
 * like "blocked", "isn't active", "not implemented" cue it to abandon
 * the tool. We start every response with a concrete next-step imperative
 * (or a clear success summary) so the loop continues productively.
 *
 * The full structured payload is still embedded as JSON beneath the
 * summary, and is also exposed via `structuredContent` for clients that
 * support typed output schemas.
 */
function jsonResult(data: unknown): MCPToolResult {
    const summary = buildActiveImperativeSummary(data);
    const json = JSON.stringify(data, null, 2);
    return {
        content: [{ type: 'text', text: `${summary}\n\n${json}` }],
        structuredContent: data as Record<string, unknown>,
    };
}

/**
 * Derive an active-imperative one-liner from an AgentRunResult-shaped
 * payload. Falls back to a neutral marker for non-result data.
 */
function buildActiveImperativeSummary(data: unknown): string {
    if (!data || typeof data !== 'object') {
        return 'Run complete.';
    }
    const r = data as Record<string, unknown>;
    const state = typeof r.state === 'string' ? r.state : undefined;
    const reason = typeof r.blockedReason === 'string' ? r.blockedReason : undefined;
    const filesCreated = Array.isArray(r.filesCreated) ? r.filesCreated.length : 0;
    switch (state) {
        case 'READY':
            return filesCreated > 0
                ? `Run complete. ${filesCreated} file(s) created. Review the diffs and keep or undo as desired.`
                : 'Run complete. Review the result for next steps.';
        case 'BLOCKED_NEED_INPUT':
            return reason
                ? `Action required: ${reason}`
                : 'Action required: collect the missing input and re-invoke `cs_ai_auto_assist` with `answers` populated.';
        case 'BLOCKED_BUDGET':
            return reason
                ? `Action required: ${reason}. Raise the budget or split the input, then re-invoke.`
                : 'Action required: raise the cost budget or split the input, then re-invoke `cs_ai_auto_assist`.';
        case 'BLOCKED_NEED_HUMAN':
            return reason
                ? `Action required: ${reason}`
                : 'Action required: review the run trace at the surfaced path, then either edit the failing file directly or adjust the input and re-invoke.';
        default:
            return reason ? `Action required: ${reason}` : 'Run complete.';
    }
}

/**
 * Build a terminal AgentRunResult from accumulated state.
 */
function makeResult(args: {
    state: AgentRunState;
    runId: string;
    mode: AgentRunMode;
    startedAt: number;
    telemetry: CSCostTelemetry;
    testsGenerated?: number;
    testsPassed?: number;
    trustScoreAvg?: number;
    filesCreated?: string[];
    blockedReason?: string;
    blockedDetails?: Record<string, unknown>;
    clarificationsNeeded?: ClarificationQuestion[];
    nextStepNeeded?: boolean;
    nextSuggestedTool?: string;
    nextSuggestedArgs?: Record<string, unknown>;
}): AgentRunResult {
    const endedAt = Date.now();
    const usage = args.telemetry.getUsage();
    // Default nextStepNeeded by terminal state. BLOCKED_* states are
    // recoverable — the LLM should re-invoke with corrected input. READY
    // is terminal. Callers can override either default.
    const defaultNextStepNeeded =
        args.nextStepNeeded ??
        (args.state === 'READY' ? false : true);
    const defaultNextTool =
        args.nextSuggestedTool ??
        (args.state === 'READY' ? undefined : 'cs_ai_auto_assist');
    return {
        state: args.state,
        runId: args.runId,
        mode: args.mode,
        startedAt: new Date(args.startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs: endedAt - args.startedAt,
        tokensTotal: usage.tokensUsed,
        costUsd: usage.costUsd,
        testsGenerated: args.testsGenerated ?? 0,
        testsPassed: args.testsPassed ?? 0,
        trustScoreAvg: args.trustScoreAvg ?? 0,
        filesCreated: args.filesCreated ?? [],
        blockedReason: args.blockedReason,
        blockedDetails: args.blockedDetails,
        clarificationsNeeded: args.clarificationsNeeded,
        nextStepNeeded: defaultNextStepNeeded,
        nextSuggestedTool: defaultNextTool,
        nextSuggestedArgs: args.nextSuggestedArgs,
    };
}

/**
 * Merge user-provided clarification answers into the classified input's
 * extracted fields. Returns a new ClassifiedInput; does not mutate the
 * argument.
 */
function mergeAnswers(
    classified: ClassifiedInput,
    answers: Record<string, string> | undefined,
): ClassifiedInput {
    if (!answers) return classified;
    return {
        ...classified,
        extractedFields: { ...classified.extractedFields, ...answers },
    };
}

// ============================================================================
// Mode Dispatch (Phase 1 ships ADO modes only as full plumbing)
// ============================================================================

/**
 * Per-mode handler signature. Either deferred (with a reason), or a
 * concrete result with feature files for the execution gate plus the
 * full generation result for downstream consumers (create-back, etc.).
 */
interface ModeDispatchResult {
    deferred: boolean;
    deferredReason?: string;
    featureFiles?: string[];
    filesCreated?: string[];
    generationResult?: GenerationResult | null;
    /**
     * Live-app anchor collected by Phase 6.5 (URL + login + nav). The
     * master tool injects these into CSConfigurationManager around the
     * heal loop so the framework's bdd_run_feature picks them up at
     * runtime, then restores the previous values to avoid leaking across
     * runs. Undefined for legacy / chat / app_url modes.
     */
    liveAppContext?: LiveAppContext;
}

/**
 * Dispatch on classified mode. All eight modes are wired end-to-end:
 *   - ADO modes: resolve → batch fetch → parse → orchestrate → write
 *   - legacy: parse → IR → transform → audit → write → heal
 *   - document / source: heuristic IR → transform → audit → write → heal
 *   - app_url: explore_application crawler → generated tests
 *   - chat: returns scaffolding-only (no real DOM, no heal)
 * Doc / source / ADO modes invoke CSLiveAppContext.ensure() before
 * generation; the resulting LiveAppContext is propagated via
 * `ModeDispatchResult.liveAppContext` so the master tool can inject it
 * into CSConfigurationManager around the heal loop.
 */
async function dispatchMode(
    classified: ClassifiedInput,
    telemetry: CSCostTelemetry,
    context: MCPToolContext,
): Promise<ModeDispatchResult> {
    const ef = classified.extractedFields;
    const adoCommon = {
        organization: ef.adoOrganization,
        project: ef.adoProject,
        pat: ef.adoPat,
    };

    switch (classified.mode) {
        case 'ado_test_case_id':
        case 'ado_test_suite_id':
        case 'ado_test_plan_id': {
            const handlerResult = await CSAdoModeHandler.handle(
                classified,
                adoCommon,
                {
                    moduleName: ef.moduleName,
                    featureName: ef.featureName,
                    appSourcePath: ef.appSourcePath,
                    outputRoot: ef.outputRoot,
                    envs: ef.envs ? ef.envs.split(',').map((e) => e.trim()) : undefined,
                    requireLiveApp: ef.requireLiveApp === 'false' ? false : undefined,
                    telemetry,
                },
                context,
            );
            if (!handlerResult.generationResult) {
                return {
                    deferred: true,
                    deferredReason:
                        handlerResult.blockedReason ??
                        `Mode '${classified.mode}' could not produce a generation result`,
                    featureFiles: [],
                    filesCreated: [],
                    generationResult: null,
                    liveAppContext: handlerResult.liveAppContext,
                };
            }
            const featureFiles = handlerResult.generationResult.filesCreated.filter(
                (p) => p.endsWith('.feature'),
            );
            return {
                deferred: false,
                featureFiles,
                filesCreated: handlerResult.generationResult.filesCreated,
                generationResult: handlerResult.generationResult,
                liveAppContext: handlerResult.liveAppContext,
            };
        }
        case 'legacy_test_code': {
            const handlerResult = await CSLegacyModeHandler.handle(
                classified,
                {
                    projectName: ef.projectName,
                    featureName: ef.featureName,
                    moduleName: ef.moduleName,
                    workspaceRoot: ef.workspaceRoot || ef.outputRoot,
                    projectRoot: ef.projectRoot,
                    environments: ef.environments
                        ? ef.environments.split(',').map((e) => e.trim())
                        : undefined,
                    skipDependencyCheck: ef.skipDependencyCheck === 'true',
                    skipConfigScaffold: ef.skipConfigScaffold === 'true',
                    overwriteExisting: ef.overwriteExisting === 'true',
                    telemetry,
                },
                context,
            );
            return finalizeDispatch(
                handlerResult.generationResult,
                handlerResult.blockedReason,
                'Legacy migration could not produce a generation result',
            );
        }
        case 'document_path': {
            const handlerResult = await CSDocumentModeHandler.handle(
                classified,
                {
                    projectName: ef.projectName,
                    featureName: ef.featureName,
                    outputRoot: ef.outputRoot,
                    sectionFocus: ef.sectionFocus,
                    requireLiveApp: ef.requireLiveApp === 'false' ? false : undefined,
                    telemetry,
                },
                context,
            );
            return finalizeDispatch(
                handlerResult.generationResult,
                handlerResult.blockedReason,
                'Document-driven generation could not produce a generation result',
                handlerResult.liveAppContext,
            );
        }
        case 'source_code_path': {
            const handlerResult = await CSSourceCodeModeHandler.handle(
                classified,
                {
                    projectName: ef.projectName,
                    featureName: ef.featureName,
                    outputRoot: ef.outputRoot,
                    targetSurface: ef.targetSurface,
                    requireLiveApp: ef.requireLiveApp === 'false' ? false : undefined,
                    telemetry,
                },
                context,
            );
            return finalizeDispatch(
                handlerResult.generationResult,
                handlerResult.blockedReason,
                'Source-driven generation could not produce a generation result',
                handlerResult.liveAppContext,
            );
        }
        case 'natural_language_chat': {
            const handlerResult = await CSChatModeHandler.handle(
                classified,
                {
                    projectName: ef.projectName,
                    featureName: ef.featureName,
                    outputRoot: ef.outputRoot,
                    telemetry,
                },
                context,
            );
            return finalizeDispatch(
                handlerResult.generationResult,
                handlerResult.blockedReason,
                'Chat-driven generation could not produce a generation result',
            );
        }
        case 'app_url': {
            const handlerResult = await CSAppUrlModeHandler.handle(
                classified,
                {
                    projectName: ef.projectName,
                    featureName: ef.featureName,
                    outputRoot: ef.outputRoot,
                    maxDurationMinutes: ef.maxDurationMinutes
                        ? Number(ef.maxDurationMinutes)
                        : undefined,
                    maxStates: ef.maxStates ? Number(ef.maxStates) : undefined,
                    strategy: ef.strategy as
                        | 'bfs'
                        | 'dfs'
                        | 'priority'
                        | 'random'
                        | undefined,
                    telemetry,
                },
                context,
            );
            return finalizeDispatch(
                handlerResult.generationResult,
                handlerResult.blockedReason,
                'App-URL exploration could not produce a generation result',
            );
        }
        default:
            return {
                deferred: true,
                deferredReason: `Mode '${classified.mode}' deferred`,
                featureFiles: [],
                filesCreated: [],
            };
    }
}

/**
 * Build a structured "what would happen" summary for `dryRun: true` runs.
 * Reads source files + checks the migration cache, but never calls the
 * Copilot delegate, the heal loop, or any external service.
 */
async function buildDryRunPreview(
    classified: ClassifiedInput,
    context: MCPToolContext,
): Promise<Record<string, unknown>> {
    const ef = classified.extractedFields;
    const preview: Record<string, unknown> = {
        mode: classified.mode,
        confidence: classified.confidence,
        extractedFields: classified.extractedFields,
    };

    const cacheableModes = new Set([
        'legacy_test_code',
        'document_path',
        'source_code_path',
    ]);

    if (cacheableModes.has(classified.mode) && ef.path) {
        try {
            const fs = await import('fs');
            if (!fs.existsSync(ef.path)) {
                preview.fileCheck = { exists: false, path: ef.path };
            } else {
                const stat = fs.statSync(ef.path);
                preview.fileCheck = {
                    exists: true,
                    path: ef.path,
                    sizeBytes: stat.size,
                };
                const cacheLookup = await CSMigrationCache.lookup(
                    {
                        sourceFile: ef.path,
                        projectName: ef.projectName || 'common',
                        // Use a stable preview pipeline version so the
                        // dry-run cache key matches the real run.
                        pipelineVersion: '1.21.0',
                        extras: classified.mode === 'document_path'
                            ? `sectionFocus=${ef.sectionFocus ?? 'all'}`
                            : classified.mode === 'source_code_path'
                                ? `targetSurface=${ef.targetSurface ?? 'ui'}`
                                : classified.mode === 'legacy_test_code' && ef.moduleName
                                    ? `moduleName=${ef.moduleName}`
                                    : undefined,
                    },
                    context,
                );
                preview.cache = cacheLookup.hit
                    ? {
                          status: 'HIT',
                          cacheKey: cacheLookup.cacheKey,
                          cachedAt: cacheLookup.cachedAt,
                          fileCount: cacheLookup.files
                              ? Object.keys(cacheLookup.files).length
                              : 0,
                          estimatedTokens: 0,
                          estimatedCostUsd: 0,
                          note: 'Cache hit — real run will replay these files; only the heal loop will spend tokens (typically 0–6K if nothing drifted).',
                      }
                    : {
                          status: 'MISS',
                          cacheKey: cacheLookup.cacheKey,
                          estimatedTokens:
                              CSAIAutoAssistEstimator.estimateMissTokens(classified.mode),
                          estimatedCostUsd:
                              CSAIAutoAssistEstimator.estimateMissCostUsd(classified.mode),
                          note: 'Cache miss — real run will call Copilot once for translation, then bounded heal cycles.',
                      };
            }
        } catch (err) {
            preview.fileCheck = {
                exists: false,
                path: ef.path,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    } else if (
        classified.mode === 'ado_test_case_id' ||
        classified.mode === 'ado_test_suite_id' ||
        classified.mode === 'ado_test_plan_id'
    ) {
        preview.adoTarget = {
            mode: classified.mode,
            id: ef.id,
            planId: ef.planId,
            note: 'Real run will fetch from ADO REST then batch via ado_work_items_get_batch. No Copilot call for ADO modes (deterministic Steps XML round-trip).',
        };
    } else if (classified.mode === 'app_url') {
        preview.appUrl = {
            url: ef.url,
            entryFlow: ef.entryFlow,
            note: 'Real run will invoke explore_application crawler. No Copilot call (deterministic crawler).',
        };
    } else if (classified.mode === 'natural_language_chat') {
        preview.chat = {
            promptLength: (ef.feature || ef.text || '').length,
            note: 'Real run will call Copilot with the user description + clarification answers as grounding. needsSourceValidation will be set on the result.',
        };
    }

    return preview;
}

/**
 * Lightweight cost estimator. Numbers come from the cost-model docs and
 * are deliberately conservative upper bounds. Not a substitute for live
 * telemetry — just enough to give the user a "do I want to spend ~$X?"
 * answer in dry-run mode.
 */
class CSAIAutoAssistEstimator {
    public static estimateMissTokens(mode: string): number {
        switch (mode) {
            case 'legacy_test_code': return 50000;
            case 'document_path': return 25000;
            case 'source_code_path': return 40000;
            case 'natural_language_chat': return 45000;
            default: return 30000;
        }
    }

    public static estimateMissCostUsd(mode: string): number {
        // Rough mid-tier: $0.000012/token average input+output blend.
        return Math.round(CSAIAutoAssistEstimator.estimateMissTokens(mode) * 0.000012 * 100) / 100;
    }
}

/**
 * Shared collapse from a mode-handler result to a `ModeDispatchResult`.
 * When the handler returned a generation result, we surface it as a
 * runnable dispatch; otherwise we return a deferred entry with the
 * handler's blockedReason (or a fallback message).
 */
function finalizeDispatch(
    generationResult: GenerationResult | null,
    blockedReason: string | undefined,
    fallbackReason: string,
    liveAppContext?: LiveAppContext,
): ModeDispatchResult {
    if (!generationResult) {
        return {
            deferred: true,
            deferredReason: blockedReason ?? fallbackReason,
            featureFiles: [],
            filesCreated: [],
            generationResult: null,
            liveAppContext,
        };
    }
    const featureFiles = generationResult.filesCreated.filter((p) =>
        p.endsWith('.feature'),
    );
    return {
        deferred: false,
        featureFiles,
        filesCreated: generationResult.filesCreated,
        generationResult,
        liveAppContext,
    };
}

// ============================================================================
// Tool Definition
// ============================================================================

/**
 * Master tool. The whole platform's surface area is collapsed into this
 * single MCP tool; downstream specialization happens via mode dispatch.
 */
const csAiAutoAssistTool: MCPToolDefinition = (defineTool() as MCPToolBuilder)
    .name('cs_ai_auto_assist')
    .title('CS-AI-Auto-Assist — Master')
    .description(
        'Master entry point for CS-AI-Auto-Assist. Takes any input ' +
            '(chat / ADO id / app URL / source path / document) and produces ' +
            'working tests with mandatory execution gating, multi-domain ' +
            'healing, and architecture-review-ready safety controls.',
    )
    .category('multiagent')
    .stringParam('input', 'User input — any format', { required: true })
    .stringParam('mode', 'Optional explicit mode override')
    .booleanParam('publishResults', 'Override ADO_INTEGRATION_ENABLED for this run only. true → push run results back to ADO; false → skip publish. Omit to honour the .env setting.')
    .booleanParam('dryRun', 'Preview-only mode. Runs sanitize → classify → clarify → cache-lookup but does NOT call the host LLM, the heal loop, or any external service. Returns a structured `preview` describing what a real run would do (cache hit/miss, estimated cost, missing clarifications).')
    .booleanParam('traceEnabled', 'When true (default), every run writes a JSONL trace to .agent-runs/runs/<runId>.jsonl. Pass false to disable trace writes for this run.')
    .objectParam('budget', 'Optional cost budget overrides (maxTokens, maxWallClockMs, maxCostUsd)')
    .objectParam('answers', 'Optional answers to prior clarification questions')
    .openWorld()
    .handler(async (params, context) => {
        const startedAt = Date.now();
        const runId = newRunId();
        const rawInput = String(params.input ?? '');
        const overrideMode = params.mode as AgentRunMode | undefined;
        const budget = params.budget as Partial<CostBudget> | undefined;
        const answers = params.answers as Record<string, string> | undefined;
        const publishResultsOverride =
            typeof params.publishResults === 'boolean'
                ? (params.publishResults as boolean)
                : undefined;
        const dryRun = params.dryRun === true;
        const traceEnabled = params.traceEnabled !== false;

        const telemetry = new CSCostTelemetry(runId, budget);
        const trace = new CSRunTrace({
            runId,
            cwd: context.server.workingDirectory,
            enabled: traceEnabled,
        });
        trace.append('run_start', {
            inputLength: rawInput.length,
            modeOverride: overrideMode,
            dryRun,
            answersProvided: answers ? Object.keys(answers).length : 0,
            budget: budget ?? null,
        });
        context.log('info', `cs_ai_auto_assist: run start`, { runId, dryRun });

        // -- Step 1: sanitize input ------------------------------------------
        // Reject only on SECRET matches (real API keys, PATs, JWTs, private
        // key blocks). PII patterns (emails, account numbers, dates) pass
        // through unchanged because legitimate test fixture data trips them.
        // Outbound LLM sampling and ADO write-back use stricter 'redact' mode.
        const sanitized = CSPiiSanitizer.sanitize(rawInput, 'reject_secrets_only');
        trace.append('sanitize', {
            decision: sanitized.decision,
            violationCount: sanitized.violations.length,
        });
        if (sanitized.decision === 'REJECTED') {
            const blockedRes = makeResult({
                state: 'BLOCKED_NEED_INPUT',
                runId,
                mode: 'unknown',
                startedAt,
                telemetry,
                blockedReason:
                    'remove the secret from your input and re-invoke. Reference credentials by their secret-store name (for example `${input:my-pat}` in mcp.json) instead of pasting raw values.',
                blockedDetails: { violations: sanitized.violations },
            });
            trace.append('run_end', { state: blockedRes.state });
            (blockedRes as unknown as Record<string, unknown>).tracePath = trace.getTracePath();
            return jsonResult(blockedRes);
        }

        // -- Step 2: classify intent -----------------------------------------
        let classified = CSIntentRouter.classify(rawInput);
        if (overrideMode) {
            classified = { ...classified, mode: overrideMode, confidence: 1 };
        }
        classified = mergeAnswers(classified, answers);
        trace.append('classify', {
            mode: classified.mode,
            confidence: classified.confidence,
            extractedFieldKeys: Object.keys(classified.extractedFields),
        });

        // -- Step 3: clarification gate --------------------------------------
        const missing = CSClarificationAgent.computeMissingFields(classified);
        const blockingMissing = missing.filter((q) => q.required && q.tier === 1);
        trace.append('clarify', {
            missingCount: missing.length,
            blockingCount: blockingMissing.length,
            blockingFields: blockingMissing.map((q) => q.field),
        });
        if (blockingMissing.length > 0 && !answers) {
            const blockedRes = makeResult({
                state: 'BLOCKED_NEED_INPUT',
                runId,
                mode: classified.mode,
                startedAt,
                telemetry,
                blockedReason:
                    'collect answers to the listed Tier-1 fields and re-invoke `cs_ai_auto_assist` with `answers: { ... }` populated. The full prompt for the user is in `blockedDetails.prompt`.',
                blockedDetails: {
                    prompt: CSClarificationAgent.formatQuestionsAsText(missing),
                    confidence: classified.confidence,
                    extractedFields: classified.extractedFields,
                },
                clarificationsNeeded: missing,
            });
            trace.append('run_end', { state: blockedRes.state });
            (blockedRes as unknown as Record<string, unknown>).tracePath = trace.getTracePath();
            return jsonResult(blockedRes);
        }

        // -- Step 4: budget pre-check ----------------------------------------
        const budgetPre = telemetry.checkBudget();
        trace.append('budget_check', { withinBudget: budgetPre.withinBudget });
        if (!budgetPre.withinBudget) {
            const blockedRes = makeResult({
                state: 'BLOCKED_BUDGET',
                runId,
                mode: classified.mode,
                startedAt,
                telemetry,
                blockedReason:
                    budgetPre.reason
                        ? `${budgetPre.reason}. Raise the cost budget (pass \`budget: { maxTokens, maxUsd, maxWallClockMs }\`) or split the input into smaller pieces, then re-invoke.`
                        : 'cost budget exhausted at start. Raise the budget (pass `budget: { maxTokens, maxUsd, maxWallClockMs }`) or split the input into smaller pieces, then re-invoke.',
            });
            trace.append('run_end', { state: blockedRes.state });
            (blockedRes as unknown as Record<string, unknown>).tracePath = trace.getTracePath();
            return jsonResult(blockedRes);
        }

        // -- Step 4.5: dry-run preview --------------------------------------
        // Skip the dispatch + heal loop. Surface what a real run WOULD do:
        // probable cache hit / miss for caching modes, file inputs the
        // delegate would receive, missing clarifications. No tokens spent.
        if (dryRun) {
            const preview = await buildDryRunPreview(classified, context);
            const previewRes = makeResult({
                state: 'READY',
                runId,
                mode: classified.mode,
                startedAt,
                telemetry,
                testsGenerated: 0,
                testsPassed: 0,
                trustScoreAvg: 0,
                filesCreated: [],
            });
            (previewRes as unknown as Record<string, unknown>).dryRun = true;
            (previewRes as unknown as Record<string, unknown>).preview = preview;
            (previewRes as unknown as Record<string, unknown>).tracePath = trace.getTracePath();
            trace.append('run_end', { state: previewRes.state, dryRun: true, preview });
            return jsonResult(previewRes);
        }

        // -- Step 5: mode dispatch (Phase 2A wires ADO modes end-to-end) ----
        let dispatch: ModeDispatchResult;
        try {
            dispatch = await dispatchMode(classified, telemetry, context);
        } catch (err) {
            return jsonResult(
                makeResult({
                    state: 'BLOCKED_NEED_HUMAN',
                    runId,
                    mode: classified.mode,
                    startedAt,
                    telemetry,
                    blockedReason:
                        'mode dispatch threw an internal error. Open the trace JSONL at the surfaced path, then re-invoke with the same input — transient failures usually clear on retry.',
                    blockedDetails: {
                        error: err instanceof Error ? err.message : String(err),
                    },
                }),
            );
        }

        if (dispatch.deferred) {
            return jsonResult(
                makeResult({
                    state: 'BLOCKED_NEED_HUMAN',
                    runId,
                    mode: classified.mode,
                    startedAt,
                    telemetry,
                    blockedReason:
                        dispatch.deferredReason ??
                        `the '${classified.mode}' handler returned without producing output. Open the trace JSONL to inspect, then re-invoke with adjusted input or add the missing handler implementation.`,
                    blockedDetails: {
                        capability: {
                            available: [
                                'intent routing',
                                'clarification',
                                'input sanitization',
                                'ADO prefetch',
                                'execution gate',
                                'trust-score formula',
                            ],
                            inProgress: ['per-mode generation handlers'],
                        },
                    },
                    filesCreated: dispatch.filesCreated ?? [],
                }),
            );
        }

        // -- Step 5.5: pre-gate audit ----------------------------------------
        // Before spending 30s+ on a BDD execution gate, run the framework's
        // deterministic rule audit across every generated artefact. PO/SD/FF/
        // DF/DB/CC violations get surfaced now (file:line + ruleId + message)
        // so the host LLM can fix them surgically via replace_string_in_file
        // and re-invoke. Saves a wasted gate run when the failure is
        // structural (missing decorator, wrong xpath escape, undefined
        // step) rather than runtime (locator drift, timing).
        let preGateAudit: PreGateAuditResult | null = null;
        const generatedFilesForAudit =
            dispatch.generationResult?.filesCreated ?? dispatch.filesCreated ?? [];
        if (generatedFilesForAudit.length > 0) {
            try {
                preGateAudit = await CSPreGateAudit.run(
                    generatedFilesForAudit,
                    context,
                );
                trace.append('pre_gate_audit', {
                    pass: preGateAudit.pass,
                    totalFiles: preGateAudit.totalFiles,
                    totalErrors: preGateAudit.totalErrors,
                    totalWarnings: preGateAudit.totalWarnings,
                });
                context.log(
                    'info',
                    `cs_ai_auto_assist: pre-gate audit ${preGateAudit.pass ? 'PASS' : 'FAIL'}`,
                    {
                        files: preGateAudit.totalFiles,
                        errors: preGateAudit.totalErrors,
                        warnings: preGateAudit.totalWarnings,
                    },
                );
                if (!preGateAudit.pass) {
                    const failingFiles = preGateAudit.files
                        .filter((f) => !f.pass)
                        .map((f) => ({
                            file: f.file,
                            errors: f.errors,
                            warnings: f.warnings,
                            violations: f.violations.slice(0, 10), // cap per-file
                        }));
                    const blockedRes = makeResult({
                        state: 'BLOCKED_NEED_HUMAN',
                        runId,
                        mode: classified.mode,
                        startedAt,
                        telemetry,
                        blockedReason: preGateAudit.summary,
                        blockedDetails: {
                            phase: 'pre_gate_audit',
                            totalErrors: preGateAudit.totalErrors,
                            totalWarnings: preGateAudit.totalWarnings,
                            failingFiles,
                            hint: 'Each violation has a ruleId (PO005, SD003, FF001, etc.). Look up the rule in the framework audit-rules skill, fix the offending line via replace_string_in_file, then re-invoke cs_ai_auto_assist with the same input.',
                        },
                        filesCreated: dispatch.generationResult?.filesCreated ?? [],
                    });
                    trace.append('run_end', { state: blockedRes.state, phase: 'pre_gate_audit' });
                    (blockedRes as unknown as Record<string, unknown>).tracePath = trace.getTracePath();
                    return jsonResult(blockedRes);
                }
            } catch (err) {
                // Audit threw — log and fall through to gate. We don't want a
                // crashing audit to block test runs that would otherwise pass.
                context.log(
                    'warning',
                    `cs_ai_auto_assist: pre-gate audit threw, continuing to gate`,
                    { error: err instanceof Error ? err.message : String(err) },
                );
            }
        }

        // -- Step 6: execution gate (with bounded heal loop) -----------------
        // Single-shot gate would be insufficient for the platform's
        // "perfectly running test" guarantee — we use CSHealLoop, which
        // runs the gate once and, on failure, classifies + proposes fixes
        // up to a bounded retry budget. The final ExecutionGateResult
        // surfaced is from the LAST gate run, so downstream judge / trust
        // score evaluations still see the latest state.
        //
        // ADO publish toggle: the framework's bdd_run_feature already drives
        // CSADOPublisher when ADO_INTEGRATION_ENABLED=true. We optionally
        // override that flag in CSConfigurationManager for this run, then
        // restore the previous value so we never leak across runs in the
        // same MCP server session.
        const featureFiles = dispatch.featureFiles ?? [];
        let gate: ExecutionGateResult | null = null;
        let healLoopAttempts = 0;
        let healLoopEscalated: string | undefined;
        let adoPublishHint: string | undefined;
        if (featureFiles.length > 0) {
            const cfg = CSConfigurationManager.getInstance();
            const previousPublishFlag = cfg.get('ADO_INTEGRATION_ENABLED', '');
            // Phase 6.5 — inject elicited live-app values so the framework's
            // bdd_run_feature picks them up at runtime. Save+restore so they
            // never leak across runs in the same MCP server session.
            const previousAppUrl = cfg.get('APP_URL', '');
            const previousAppUsername = cfg.get('APP_USERNAME', '');
            const liveAppContext = dispatch.liveAppContext;
            const isAdoMode =
                classified.mode === 'ado_test_case_id' ||
                classified.mode === 'ado_test_suite_id' ||
                classified.mode === 'ado_test_plan_id';
            try {
                if (liveAppContext && liveAppContext.source === 'elicited') {
                    cfg.set('APP_URL', liveAppContext.appUrl);
                    if (liveAppContext.username) {
                        cfg.set('APP_USERNAME', liveAppContext.username);
                    }
                    context.log(
                        'info',
                        `cs_ai_auto_assist: injected elicited APP_URL${liveAppContext.username ? ' + APP_USERNAME' : ''} for heal-loop runtime`,
                    );
                }
                if (publishResultsOverride === true) {
                    cfg.set('ADO_INTEGRATION_ENABLED', 'true');
                    context.log(
                        'info',
                        'cs_ai_auto_assist: ADO publishing enabled for this run (publishResults=true)',
                    );
                } else if (publishResultsOverride === false) {
                    cfg.set('ADO_INTEGRATION_ENABLED', 'false');
                    context.log(
                        'info',
                        'cs_ai_auto_assist: ADO publishing disabled for this run (publishResults=false)',
                    );
                } else if (isAdoMode && cfg.getBoolean('ADO_INTEGRATION_ENABLED', false) !== true) {
                    adoPublishHint =
                        'ADO publishing is disabled. Set ADO_INTEGRATION_ENABLED=true in your .env, or pass publishResults=true to push run results back to ADO.';
                    context.log('info', `cs_ai_auto_assist: ${adoPublishHint}`);
                }
                const healed = await CSHealLoop.heal(
                    featureFiles,
                    {
                        telemetry,
                        maxAttemptsPerFailure: 3,
                        maxGlobalAttempts: 20,
                    },
                    context,
                );
                gate = healed.finalGate;
                healLoopAttempts = healed.totalAttempts;
                healLoopEscalated = healed.escalatedReason;
            } finally {
                if (publishResultsOverride !== undefined) {
                    cfg.set('ADO_INTEGRATION_ENABLED', previousPublishFlag);
                }
                if (liveAppContext && liveAppContext.source === 'elicited') {
                    cfg.set('APP_URL', previousAppUrl);
                    if (liveAppContext.username) {
                        cfg.set('APP_USERNAME', previousAppUsername);
                    }
                }
            }
        }

        // -- Step 6.4: persist verified-green output to migration cache ------
        // Mode handlers stamp cacheKey + cacheableFiles on the GenerationResult
        // when they ran a fresh delegate call (cache miss). After the heal
        // loop confirms green, we save the file map so the next run on the
        // same input replays the cached output without invoking Copilot.
        if (
            gate?.passed === true &&
            dispatch.generationResult &&
            dispatch.generationResult.cacheKey &&
            dispatch.generationResult.cacheableFiles
        ) {
            try {
                const stored = await CSMigrationCache.store(
                    {
                        cacheKey: dispatch.generationResult.cacheKey,
                        files: dispatch.generationResult.cacheableFiles,
                    },
                    context,
                );
                if (stored) {
                    context.log(
                        'info',
                        `cs_ai_auto_assist: cached verified-green output (cacheKey=${dispatch.generationResult.cacheKey})`,
                    );
                }
            } catch (err) {
                context.log(
                    'warning',
                    'cs_ai_auto_assist: cache store failed (non-fatal)',
                    {
                        error: err instanceof Error ? err.message : String(err),
                    },
                );
            }
        }

        // -- Step 6.5: optional ADO create-back ------------------------------
        // Only runs when the gate passed AND the user explicitly named a
        // create-back target. This is the "tests pass + push back to ADO"
        // half of the bidirectional sync.
        const createBackPlan = Number(classified.extractedFields.createBackPlanId);
        const createBackSuite = Number(classified.extractedFields.createBackSuiteId);
        let createBackResult: Awaited<ReturnType<typeof CSAdoCreateBackFlow.maybeCreateBack>> | null = null;
        if (
            gate?.passed === true &&
            dispatch.generationResult &&
            Number.isFinite(createBackPlan) &&
            createBackPlan > 0 &&
            Number.isFinite(createBackSuite) &&
            createBackSuite > 0
        ) {
            try {
                createBackResult = await CSAdoCreateBackFlow.maybeCreateBack(
                    dispatch.generationResult,
                    createBackPlan,
                    createBackSuite,
                    {
                        organization: classified.extractedFields.adoOrganization,
                        project: classified.extractedFields.adoProject,
                        pat: classified.extractedFields.adoPat,
                    },
                    context,
                );
            } catch (err) {
                context.log(
                    'warning',
                    'cs_ai_auto_assist: create-back failed (non-fatal)',
                    { error: err instanceof Error ? err.message : String(err) },
                );
            }
        }

        // -- Step 7: trust-score per generated test --------------------------
        const trustInputs = (judge?: JudgeVerdict): TrustScoreInputs => ({
            sourceGrounded: classified.mode !== 'natural_language_chat',
            executed: gate !== null,
            judgeVerdict: judge?.verdict ?? 'PASS_WEAK',
            hasAlternativeLocators: false,
            hasMeaningfulAssertions: judge?.meaningful === true,
            commitReadyCheckPassed: gate?.passed === true,
            healCyclesUsed: 0,
        });
        const trust = featureFiles.length > 0
            ? CSTrustScore.compute(trustInputs(gate?.judgeVerdict))
            : 0;

        // -- Step 8: terminal result -----------------------------------------
        const passed = gate?.passed === true;
        const baseResult = makeResult({
            state: passed ? 'READY' : 'BLOCKED_NEED_HUMAN',
            runId,
            mode: classified.mode,
            startedAt,
            telemetry,
            testsGenerated: featureFiles.length,
            testsPassed: gate?.testsPassed ?? 0,
            trustScoreAvg: trust,
            filesCreated: dispatch.filesCreated ?? [],
            blockedReason: passed ? undefined : gate?.reason,
            blockedDetails: passed
                ? undefined
                : {
                    failures: gate?.testsFailedClassified ?? [],
                    judgeVerdict: gate?.judgeVerdict,
                },
        });
        if (createBackResult) {
            (baseResult as unknown as Record<string, unknown>).createBack = {
                createdTestCaseIds: createBackResult.createdTestCaseIds,
                linkedScenarios: createBackResult.linkedScenarios,
                skipped: createBackResult.skipped,
                updatedFiles: createBackResult.updatedFiles,
            };
        }
        if (healLoopAttempts > 0 || healLoopEscalated) {
            (baseResult as unknown as Record<string, unknown>).healLoop = {
                attempts: healLoopAttempts,
                escalated: healLoopEscalated,
            };
        }
        // Surface the ADO test run URL when the framework's CSADOPublisher
        // started a run during bdd_run_feature. The publisher is loaded
        // lazily by CSBDDRunner, so we dynamic-import it to avoid pulling
        // it into our module's static graph when ADO publishing is off.
        try {
            const cfg = CSConfigurationManager.getInstance();
            if (cfg.getBoolean('ADO_INTEGRATION_ENABLED', false) === true) {
                const mod = await import('../../ado/CSADOPublisher');
                const publisher = (mod as { CSADOPublisher: { getInstance(): { getCurrentTestRun(): { id: number; name: string } | undefined } } }).CSADOPublisher.getInstance();
                const run = publisher.getCurrentTestRun();
                if (run && run.id) {
                    const org = cfg.get('ADO_ORGANIZATION', '');
                    const proj = cfg.get('ADO_PROJECT', '');
                    const baseUrl = cfg.get('ADO_BASE_URL', 'https://dev.azure.com');
                    const webAccessUrl = org && proj
                        ? `${baseUrl}/${encodeURIComponent(org)}/${encodeURIComponent(proj)}/_testManagement/runs?runId=${run.id}&_a=runCharts`
                        : undefined;
                    (baseResult as unknown as Record<string, unknown>).adoRun = {
                        runId: run.id,
                        name: run.name,
                        webAccessUrl,
                    };
                }
            }
        } catch (err) {
            // Publisher not loaded / disabled — non-fatal.
            context.log('debug', 'cs_ai_auto_assist: ADO run URL surfacing skipped', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        if (adoPublishHint) {
            (baseResult as unknown as Record<string, unknown>).adoPublishHint =
                adoPublishHint;
        }
        if (dispatch.generationResult?.cacheHit) {
            (baseResult as unknown as Record<string, unknown>).cacheHit =
                dispatch.generationResult.cacheHit;
        } else if (dispatch.generationResult?.cacheKey && passed) {
            (baseResult as unknown as Record<string, unknown>).cacheStored = {
                cacheKey: dispatch.generationResult.cacheKey,
            };
        }
        (baseResult as unknown as Record<string, unknown>).tracePath = trace.getTracePath();
        trace.append('run_end', {
            state: baseResult.state,
            tokensTotal: baseResult.tokensTotal,
            costUsd: baseResult.costUsd,
            durationMs: baseResult.durationMs,
            testsPassed: baseResult.testsPassed,
            healAttempts: healLoopAttempts,
        });
        return jsonResult(baseResult);
    })
    .build();

// ============================================================================
// Registration
// ============================================================================

/**
 * The full set of tools exported by the agent-platform module. Currently a
 * single master tool; future Phase-2 work may add per-mode entry points.
 */
export const agentPlatformTools: MCPToolDefinition[] = [csAiAutoAssistTool];

/**
 * Register the agent-platform tools with the supplied registry. Idempotent
 * iff the registry has not seen the tool name before.
 */
export function registerAgentPlatformTools(registry: CSMCPToolRegistry): void {
    registry.registerTools(agentPlatformTools);
}
