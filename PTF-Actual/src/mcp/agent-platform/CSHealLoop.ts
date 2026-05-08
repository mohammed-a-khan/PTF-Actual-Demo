/**
 * Agentic Test Platform — Bounded Heal Loop
 *
 * Wraps `CSExecutionGate` in a retry-with-fix loop. On failure: classify the
 * error, look up past corrections, propose a fix via MCP sampling, gate the
 * proposed content through `audit_content`, apply it, then re-run the gate.
 *
 * The loop is hard-bounded by `maxAttemptsPerFailure` and
 * `maxGlobalAttempts` so a stuck test can never burn unbounded LLM tokens
 * or wall-clock. A bounded budget is enforced when the caller passes a
 * `CSCostTelemetry`.
 *
 * Used by Phase 2A (ADO mode) and Phase 2B (legacy mode) to guarantee the
 * "perfectly running test" outcome the platform promises. Single-shot gate
 * behaviour is recoverable here: the gate's PASS_REAL verdict from
 * CSResultJudge gates the heal-success exit, so weak/stub assertions still
 * fail and trigger another fix attempt.
 *
 * Privacy-by-design: the file under heal is read locally; only the
 * sanitized failure summary + the smallest necessary code window are sent
 * over MCP sampling. PII / secrets in source content are stripped before
 * the sampling call via `CSPiiSanitizer.sanitize(..., 'redact')`.
 *
 * @module agent-platform/CSHealLoop
 */

import * as fs from 'fs';
import * as path from 'path';
import { MCPToolContext, MCPToolDefinition, MCPToolResult } from '../types/CSMCPTypes';
import { auditTools } from '../tools/audit/CSMCPAuditTools';
import { pipelineTools } from '../tools/pipeline/CSMCPPipelineTools';
import {
    CSExecutionGate,
    ExecutionGateResult,
    ExecutionGateFailure,
} from './CSExecutionGate';
import { CSPiiSanitizer } from './CSPiiSanitizer';
import { CSCostTelemetry } from './CSCostTelemetry';

// ============================================================================
// Types
// ============================================================================

export interface HealAttempt {
    attemptNumber: number;
    failureType: string;
    testId: string;
    classification: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
    fixSource: 'memory' | 'sampling' | 'none';
    fixApplied: boolean;
    afterAttemptPassed: boolean;
    notes?: string;
    /**
     * Failure signature used as the correction-memory lookup key. Stored on
     * the attempt so the heal loop can record the strategy as
     * verified-green when the gate later passes.
     */
    signature?: string;
    /** One-line summary of the strategy the LLM applied — for memory record. */
    strategy?: string;
}

export interface HealLoopResult {
    finalGate: ExecutionGateResult;
    attempts: HealAttempt[];
    totalAttempts: number;
    perfectlyPassing: boolean;
    escalatedReason?: string;
}

export interface HealLoopOptions {
    /** Stop trying to heal a single failure after this many fix-and-retry rounds. */
    maxAttemptsPerFailure?: number;
    /** Hard cap across all failures, prevents runaway budgets. */
    maxGlobalAttempts?: number;
    /** When set, every iteration consults the budget; loop bails early when exhausted. */
    telemetry?: CSCostTelemetry;
    /**
     * If true (default), HIGH-severity failures (auth/network/server-500/db) are
     * escalated immediately without LLM proposals — they are environmental and
     * not fixable from the test code.
     */
    escalateHighSeverity?: boolean;
}

// ============================================================================
// CSHealLoop
// ============================================================================

/**
 * Static loop driver. Single public entry point: `heal`.
 */
export class CSHealLoop {
    private static readonly DEFAULT_MAX_PER_FAILURE = 3;
    private static readonly DEFAULT_MAX_GLOBAL = 20;
    /** Max characters of source we put in front of the sampling LLM. */
    private static readonly MAX_SOURCE_WINDOW = 4 * 1024;
    /** Max characters of failure detail we forward to the sampler / classifier. */
    private static readonly MAX_FAILURE_DETAIL = 8 * 1024;

    /**
     * Run gate → if green, return. Otherwise loop: classify each failure, try
     * to heal it (memory > sampling > escalate), reapply, re-run.
     */
    public static async heal(
        featureFiles: string[],
        options: HealLoopOptions,
        context: MCPToolContext,
    ): Promise<HealLoopResult> {
        const maxPerFailure = options.maxAttemptsPerFailure ?? CSHealLoop.DEFAULT_MAX_PER_FAILURE;
        const maxGlobal = options.maxGlobalAttempts ?? CSHealLoop.DEFAULT_MAX_GLOBAL;
        const escalateHigh = options.escalateHighSeverity !== false;

        const attempts: HealAttempt[] = [];
        const failureAttemptCount = new Map<string, number>();

        // -- Initial gate run -----------------------------------------------
        let gate = await CSExecutionGate.execute(featureFiles, context);
        if (gate.passed) {
            return {
                finalGate: gate,
                attempts,
                totalAttempts: 0,
                perfectlyPassing: true,
            };
        }

        let globalAttempts = 0;
        let escalatedReason: string | undefined;

        // -- Fast-fail when no sampling available ---------------------------
        // The auto-fix loop's only mechanism for proposing a code patch is
        // sampling/createMessage on the host LLM. Copilot doesn't implement
        // sampling, so every retry would call proposeFixViaSampling, fail
        // with "no sampling client", and burn one of the 20 global retries
        // doing nothing useful. Detect that condition once and escalate
        // immediately with the gate's structured failure data — the host
        // LLM (Copilot in chat) reads it and drives healing through tool
        // calls (apply_patch, etc.) instead.
        if (!context.sampling) {
            // Best-effort: classify each failure and look up correction
            // memory so the escalation surfaces actionable strategy hints
            // even though we won't auto-apply them.
            for (const failure of gate.testsFailedClassified ?? []) {
                const summary = failure.details.slice(0, CSHealLoop.MAX_FAILURE_DETAIL);
                const signature = `${failure.failureType}: ${summary.slice(0, 256)}`;
                const classification = await CSHealLoop.classify(
                    summary,
                    failure.testId,
                    context,
                );
                const memoryHit = await CSHealLoop.queryMemory(signature, context);
                attempts.push({
                    attemptNumber: 1,
                    failureType: failure.failureType,
                    testId: failure.testId,
                    classification: classification === 'UNKNOWN' ? 'LOW' : classification,
                    fixSource: 'none',
                    fixApplied: false,
                    afterAttemptPassed: false,
                    notes: memoryHit
                        ? `host LLM should drive fix; correction memory has prior verified-green strategy: ${memoryHit.fixStrategy}`
                        : 'host LLM should read gate failure detail and propose a fix via apply_patch on the implicated page object or step file',
                    signature,
                    strategy: memoryHit?.fixStrategy,
                });
            }
            return {
                finalGate: gate,
                attempts,
                totalAttempts: 0,
                perfectlyPassing: false,
                escalatedReason:
                    'auto-fix path not active in this host. The host LLM (Copilot) should read `finalGate.testsFailedClassified` and `attempts[].strategy`, drive the fix via apply_patch on the implicated file, then re-invoke `cs_ai_auto_assist` with the same input to re-run the gate.',
            };
        }

        // -- Heal loop ------------------------------------------------------
        while (globalAttempts < maxGlobal) {
            // Budget guard.
            if (options.telemetry) {
                const budget = options.telemetry.checkBudget();
                if (!budget.withinBudget) {
                    escalatedReason = `budget exhausted: ${budget.reason ?? 'limit reached'}`;
                    break;
                }
            }

            // Pick the first unhealed failure that still has retries left.
            const target = CSHealLoop.pickTarget(
                gate.testsFailedClassified,
                failureAttemptCount,
                maxPerFailure,
            );
            if (!target) {
                escalatedReason =
                    'all failures exhausted their per-failure attempt budget';
                break;
            }

            globalAttempts += 1;
            const attemptCount = (failureAttemptCount.get(target.testId) ?? 0) + 1;
            failureAttemptCount.set(target.testId, attemptCount);

            const attempt = await CSHealLoop.healOne(
                target,
                attemptCount,
                escalateHigh,
                context,
            );
            attempts.push(attempt);

            if (!attempt.fixApplied) {
                // No applicable fix this round. If we still have retries left
                // for this failure we'd just re-attempt with the same data, so
                // bump the counter to its cap to force progression.
                if (attempt.notes?.startsWith('escalate')) {
                    failureAttemptCount.set(target.testId, maxPerFailure);
                }
                continue;
            }

            // Re-run the gate. We re-run everything (cheap on a single
            // feature; on multi-feature plans the gate's per-feature run is
            // already minimal). The full re-run also catches cascade
            // regressions introduced by the fix.
            gate = await CSExecutionGate.execute(featureFiles, context);
            attempt.afterAttemptPassed = gate.passed;
            if (gate.passed) {
                // The fix that just landed produced a verified-green run.
                // Persist its strategy to the framework's correction memory
                // so the next time a similar failure shows up the LLM gets
                // it as grounding. Best-effort — do not surface failures.
                if (
                    attempt.fixApplied &&
                    attempt.signature &&
                    attempt.strategy &&
                    attempt.classification !== 'UNKNOWN'
                ) {
                    CSHealLoop.recordCorrection(
                        attempt.signature,
                        attempt.classification,
                        target.failureType,
                        attempt.strategy,
                        undefined,
                        context,
                    ).catch(() => undefined);
                }
                return {
                    finalGate: gate,
                    attempts,
                    totalAttempts: globalAttempts,
                    perfectlyPassing: true,
                };
            }
        }

        if (!escalatedReason) {
            escalatedReason = `global attempt cap reached (${maxGlobal})`;
        }
        return {
            finalGate: gate,
            attempts,
            totalAttempts: globalAttempts,
            perfectlyPassing: false,
            escalatedReason,
        };
    }

    // ========================================================================
    // Heal a single failure
    // ========================================================================

    private static async healOne(
        failure: ExecutionGateFailure,
        attemptNumber: number,
        escalateHigh: boolean,
        context: MCPToolContext,
    ): Promise<HealAttempt> {
        const summary = failure.details.slice(0, CSHealLoop.MAX_FAILURE_DETAIL);
        // Signature is the failure-type prefix + a stable slice of the detail.
        // `correction_memory_*` hash this signature for storage / lookup.
        const signature = `${failure.failureType}: ${summary.slice(0, 256)}`;

        // -- Step 1: classify the failure -----------------------------------
        const classification = await CSHealLoop.classify(
            summary,
            failure.testId,
            context,
        );

        if (classification === 'HIGH' && escalateHigh) {
            return {
                attemptNumber,
                failureType: failure.failureType,
                testId: failure.testId,
                classification,
                fixSource: 'none',
                fixApplied: false,
                afterAttemptPassed: false,
                notes: 'escalate: HIGH severity (environment / regression)',
                signature,
            };
        }

        // -- Step 2: memory lookup ------------------------------------------
        // The framework's correction_memory stores STRATEGIES (root-cause +
        // approach), not file patches. A hit becomes grounding for the
        // sampling call below, not a shortcut.
        const memoryHit = await CSHealLoop.queryMemory(signature, context);

        // -- Step 3: LLM-propose a fix --------------------------------------
        if (!context.sampling) {
            return {
                attemptNumber,
                failureType: failure.failureType,
                testId: failure.testId,
                classification,
                fixSource: 'none',
                fixApplied: false,
                afterAttemptPassed: false,
                notes:
                    'escalate: no sampling client available; cannot propose fix',
                signature,
            };
        }

        const proposal = await CSHealLoop.proposeFixViaSampling(
            failure,
            summary,
            classification,
            memoryHit,
            context,
        );
        if (!proposal) {
            return {
                attemptNumber,
                failureType: failure.failureType,
                testId: failure.testId,
                classification: classification === 'UNKNOWN' ? 'LOW' : classification,
                fixSource: memoryHit ? 'memory' : 'sampling',
                fixApplied: false,
                afterAttemptPassed: false,
                notes: 'sampler returned no usable fix or chose to give up',
                signature,
            };
        }

        const applied = await CSHealLoop.applyFix(
            proposal.filePath,
            proposal.newContent,
            context,
        );

        // Strategy is whatever short text the proposal carried (or a
        // synthesized one). Saved on the attempt so the loop can record it
        // verified-green only when the very last applied fix made the gate
        // pass — `correction_memory_record` refuses unverified entries.
        const strategy =
            proposal.strategy ||
            (memoryHit?.fixStrategy
                ? `Reused strategy: ${memoryHit.fixStrategy}`
                : `LLM-proposed patch on ${proposal.filePath}`);

        return {
            attemptNumber,
            failureType: failure.failureType,
            testId: failure.testId,
            classification: classification === 'UNKNOWN' ? 'LOW' : classification,
            fixSource: memoryHit ? 'memory' : 'sampling',
            fixApplied: applied,
            afterAttemptPassed: false,
            notes: applied
                ? memoryHit
                    ? 'applied LLM patch grounded in memory hit'
                    : 'applied fix from sampling'
                : 'fix failed pre-apply audit',
            signature,
            strategy,
        };
    }

    // ========================================================================
    // Tool helpers
    // ========================================================================

    private static async classify(
        errorMessage: string,
        scenarioId: string,
        context: MCPToolContext,
    ): Promise<'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN'> {
        const result = await CSHealLoop.invokeTool(
            pipelineTools,
            'classify_failure',
            { errorMessage, scenarioId },
            context,
        );
        if (result.isError) return 'UNKNOWN';
        const sc = result.structuredContent as Record<string, unknown> | undefined;
        const cls = sc?.class as string | undefined;
        if (cls === 'LOW' || cls === 'MEDIUM' || cls === 'HIGH') return cls;
        return 'UNKNOWN';
    }

    /**
     * Query the framework's correction memory by failure signature. The
     * memory stores STRATEGIES (one-line root-cause + fix-approach pairs),
     * not file patches — so a hit is grounding for the next sampling call,
     * not a complete answer.
     */
    private static async queryMemory(
        signature: string,
        context: MCPToolContext,
    ): Promise<{ rootCause: string; fixStrategy: string } | null> {
        try {
            const result = await CSHealLoop.invokeTool(
                pipelineTools,
                'correction_memory_query',
                { signature },
                context,
            );
            if (result.isError) return null;
            const sc = result.structuredContent as
                | Record<string, unknown>
                | undefined;
            const exact = sc?.exactHit as Record<string, unknown> | null | undefined;
            if (exact && typeof exact === 'object') {
                const rootCause = String(exact.rootCause ?? '');
                const fixStrategy = String(exact.fixStrategy ?? '');
                if (fixStrategy) return { rootCause, fixStrategy };
            }
            // Fall back to the first partial hit if no exact match.
            const hits = sc?.hits as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(hits) && hits.length > 0) {
                const first = hits[0];
                const rootCause = String(first.rootCause ?? '');
                const fixStrategy = String(first.fixStrategy ?? '');
                if (fixStrategy) return { rootCause, fixStrategy };
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Persist a verified-green strategy to the correction memory. Only call
     * this after the gate has confirmed the fix produced a passing run —
     * `correction_memory_record` refuses unverified entries.
     */
    private static async recordCorrection(
        signature: string,
        classification: 'LOW' | 'MEDIUM' | 'HIGH',
        rootCause: string,
        fixStrategy: string,
        examplePatch: string | undefined,
        context: MCPToolContext,
    ): Promise<void> {
        await CSHealLoop.invokeTool(
            pipelineTools,
            'correction_memory_record',
            {
                signature,
                failureClass: classification,
                rootCause,
                fixStrategy,
                verifiedGreen: true,
                examplePatch,
            },
            context,
        );
    }

    /**
     * Apply a proposed fix: pre-gate it through `audit_content`, then write
     * it. Returns true iff both the gate and the write succeeded.
     */
    private static async applyFix(
        filePath: string,
        newContent: string,
        context: MCPToolContext,
    ): Promise<boolean> {
        const auditResult = await CSHealLoop.invokeTool(
            auditTools,
            'audit_content',
            { filePath, content: newContent },
            context,
        );
        if (auditResult.isError) return false;
        const sc = auditResult.structuredContent as
            | Record<string, unknown>
            | undefined;
        const ok = sc?.ok === true || sc?.passed === true || sc?.violations === 0;
        if (!ok) return false;
        try {
            fs.writeFileSync(filePath, newContent, 'utf-8');
            return true;
        } catch (err) {
            context.log(
                'warning',
                'CSHealLoop.applyFix: write failed',
                {
                    filePath,
                    error: err instanceof Error ? err.message : String(err),
                },
            );
            return false;
        }
    }

    // ========================================================================
    // Sampling-based fix proposal
    // ========================================================================

    private static async proposeFixViaSampling(
        failure: ExecutionGateFailure,
        sanitizedFailureDetail: string,
        classification: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN',
        memoryHit: { rootCause: string; fixStrategy: string } | null,
        context: MCPToolContext,
    ): Promise<{ filePath: string; newContent: string; strategy?: string } | null> {
        if (!context.sampling) return null;

        const candidatePath = CSHealLoop.guessFilePath(failure);
        let sourceWindow = '';
        let resolvedPath = candidatePath;
        if (candidatePath) {
            try {
                const raw = fs.readFileSync(candidatePath, 'utf-8');
                const redacted = CSPiiSanitizer.sanitize(raw, 'redact').cleaned;
                sourceWindow = redacted.slice(0, CSHealLoop.MAX_SOURCE_WINDOW);
            } catch {
                sourceWindow = '';
            }
        }

        // Visual reasoning: when the failure looks like locator drift
        // (LOW classification + locator/timeout/element-not-found patterns),
        // attach the most-recent evidence screenshot so the LLM can reason
        // about visual changes alongside the source. Best-effort — silently
        // skip when no screenshot is available.
        const screenshot = CSHealLoop.findLatestScreenshot(failure);

        const prompt = CSHealLoop.buildPrompt({
            failureType: failure.failureType,
            classification,
            failureDetail: CSPiiSanitizer.sanitize(
                sanitizedFailureDetail,
                'redact',
            ).cleaned,
            filePath: resolvedPath,
            sourceWindow,
            memoryHit,
            screenshotAttached: screenshot !== null,
        });

        const messageContent: Array<
            { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
        > = [{ type: 'text', text: prompt }];
        if (screenshot) {
            messageContent.push({
                type: 'image',
                data: screenshot.base64,
                mimeType: screenshot.mimeType,
            });
        }

        try {
            const sampling = context.sampling;
            const response = await sampling.createMessage({
                messages: [
                    {
                        role: 'user',
                        // Cast to any here because the MCP SDK's content
                        // type is text-only in older versions; recent specs
                        // accept image content blocks per JSON-RPC. Hosts
                        // that don't support image fall back to text.
                        content: messageContent.length === 1
                            ? messageContent[0]
                            : (messageContent as unknown as { type: 'text'; text: string }),
                    },
                ],
                maxTokens: 2048,
                temperature: 0.2,
                systemPrompt:
                    'You are a senior test automation engineer. Propose minimal patches that compile and pass the failing scenario. When a screenshot is attached, use it to reason about visual changes (locator drift, layout shift, hidden elements). Reply ONLY in the requested JSON shape.',
            });
            const raw = CSHealLoop.firstTextBlock(response);
            return CSHealLoop.parseProposal(raw, resolvedPath);
        } catch (err) {
            context.log('warning', 'CSHealLoop: sampling failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
    }

    /**
     * Look for the most recent screenshot in the framework's evidence
     * output that's relevant to this failure. Returns base64-encoded
     * content + mime type, or null when no screenshot is available.
     *
     * Heuristic: walk `<cwd>/<project>-results/` (or `test-results/`)
     * looking for `.png` / `.jpg` files modified in the last 5 minutes.
     * Cap file size at 1 MB to keep the sampling payload bounded.
     */
    private static findLatestScreenshot(
        failure: ExecutionGateFailure,
    ): { base64: string; mimeType: string } | null {
        const ext = path.extname(failure.testId).toLowerCase();
        // Locator-drift failures benefit most from visual context.
        if (
            !/locator|element.*not.*found|timeout.*selector|expected.*text/i.test(
                failure.details,
            )
        ) {
            return null;
        }
        const cwd = process.cwd();
        const candidates: string[] = [];
        for (const dir of [
            path.join(cwd, 'test-results'),
            path.join(cwd, 'reports'),
            path.join(cwd, 'evidence'),
        ]) {
            try {
                CSHealLoop.collectRecentImages(dir, candidates, 5 * 60 * 1000);
            } catch {
                // Ignore unreadable dirs.
            }
            if (candidates.length > 5) break;
        }
        if (candidates.length === 0) return null;
        // Pick the most recent.
        candidates.sort((a, b) => {
            try {
                return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
            } catch {
                return 0;
            }
        });
        const chosen = candidates[0];
        try {
            const stat = fs.statSync(chosen);
            if (stat.size > 1024 * 1024) return null; // skip oversize
            const buf = fs.readFileSync(chosen);
            const lower = chosen.toLowerCase();
            const mimeType =
                lower.endsWith('.jpg') || lower.endsWith('.jpeg')
                    ? 'image/jpeg'
                    : 'image/png';
            return { base64: buf.toString('base64'), mimeType };
        } catch {
            return null;
        }
        // Suppress unused-locals warning for `ext` — kept as a hook for
        // future per-extension heuristics.
        void ext;
    }

    private static collectRecentImages(
        dir: string,
        out: string[],
        windowMs: number,
    ): void {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const now = Date.now();
        for (const entry of entries) {
            if (out.length >= 10) return;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                CSHealLoop.collectRecentImages(full, out, windowMs);
                continue;
            }
            const lower = entry.name.toLowerCase();
            if (!lower.endsWith('.png') && !lower.endsWith('.jpg') && !lower.endsWith('.jpeg')) {
                continue;
            }
            try {
                const stat = fs.statSync(full);
                if (now - stat.mtimeMs <= windowMs) {
                    out.push(full);
                }
            } catch {
                // Ignore.
            }
        }
    }

    private static buildPrompt(args: {
        failureType: string;
        classification: string;
        failureDetail: string;
        filePath?: string;
        sourceWindow: string;
        memoryHit: { rootCause: string; fixStrategy: string } | null;
        screenshotAttached?: boolean;
    }): string {
        const lines: string[] = [
            'A generated test failed. Propose the minimal code change that will',
            'make the scenario green without changing test intent.',
            '',
            `Failure type: ${args.failureType}`,
            `Classification: ${args.classification}`,
            'Failure detail (sanitized):',
            args.failureDetail,
            '',
        ];
        if (args.screenshotAttached) {
            lines.push(
                '# Visual context attached — inspect the screenshot for layout / locator drift / hidden elements.',
            );
            lines.push('');
        }
        if (args.memoryHit) {
            lines.push('# Previously verified strategy for similar failure');
            if (args.memoryHit.rootCause) {
                lines.push(`Root cause: ${args.memoryHit.rootCause}`);
            }
            lines.push(`Strategy that worked: ${args.memoryHit.fixStrategy}`);
            lines.push('Apply this strategy to the file below if it fits.');
            lines.push('');
        }
        lines.push(
            args.filePath
                ? `Likely file to patch: ${args.filePath}`
                : 'No file path identified — return giveUp:true if you cannot infer one.',
        );
        lines.push(
            args.sourceWindow
                ? 'Current file content (sanitized, possibly truncated):'
                : 'No source window available.',
        );
        lines.push(args.sourceWindow);
        lines.push('');
        lines.push('Reply with ONE JSON object on a single line, no Markdown fence:');
        lines.push('{"filePath": "<absolute or workspace-relative path>",');
        lines.push(' "newContent": "<full new file content>",');
        lines.push(' "strategy": "<one-line description of the fix approach>"}');
        lines.push('or');
        lines.push('{"giveUp": true, "reason": "<why you cannot fix>"}');
        return lines.join('\n');
    }

    private static firstTextBlock(response: unknown): string {
        const r = response as Record<string, unknown> | undefined;
        if (!r) return '';
        const content = r.content as { type?: string; text?: string }[] | undefined;
        if (Array.isArray(content)) {
            for (const part of content) {
                if (part?.type === 'text' && typeof part.text === 'string') {
                    return part.text;
                }
            }
        }
        if (typeof r.text === 'string') return r.text;
        return '';
    }

    private static parseProposal(
        raw: string,
        defaultFilePath?: string,
    ): { filePath: string; newContent: string; strategy?: string } | null {
        const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace < 0 || lastBrace <= firstBrace) return null;
        const slice = cleaned.slice(firstBrace, lastBrace + 1);
        try {
            const obj = JSON.parse(slice) as Record<string, unknown>;
            if (obj.giveUp === true) return null;
            const filePath =
                (typeof obj.filePath === 'string' && obj.filePath) ||
                defaultFilePath ||
                '';
            const newContent =
                typeof obj.newContent === 'string' ? obj.newContent : '';
            const strategy =
                typeof obj.strategy === 'string' ? obj.strategy : undefined;
            if (!filePath || !newContent) return null;
            return { filePath, newContent, strategy };
        } catch {
            return null;
        }
    }

    // ========================================================================
    // Misc
    // ========================================================================

    /**
     * Pick the next failure that still has retries left. Skips failures that
     * have already exhausted their per-failure attempt budget.
     */
    private static pickTarget(
        failures: ExecutionGateFailure[],
        failureAttemptCount: Map<string, number>,
        maxPerFailure: number,
    ): ExecutionGateFailure | null {
        for (const f of failures) {
            const used = failureAttemptCount.get(f.testId) ?? 0;
            if (used < maxPerFailure) return f;
        }
        return null;
    }

    /**
     * Heuristic: pull a file path out of a failure's `details` block.
     * Looks for absolute paths, then workspace-relative `.ts`/`.feature`
     * paths. Falls back to the testId when it itself looks like a path.
     */
    private static guessFilePath(failure: ExecutionGateFailure): string | undefined {
        const candidates: string[] = [];
        const absRe = /(\/[^\s:'"]+\.(?:ts|tsx|feature|json))/g;
        const relRe = /([\w./-]+\.(?:ts|tsx|feature|json))/g;
        let m: RegExpExecArray | null;
        while ((m = absRe.exec(failure.details)) !== null) {
            candidates.push(m[1]);
        }
        if (candidates.length === 0) {
            while ((m = relRe.exec(failure.details)) !== null) {
                candidates.push(m[1]);
            }
        }
        if (candidates.length > 0) return candidates[0];
        if (
            failure.testId.endsWith('.feature') ||
            failure.testId.endsWith('.ts')
        ) {
            return failure.testId;
        }
        return undefined;
    }

    private static async invokeTool(
        defs: MCPToolDefinition[],
        toolName: string,
        params: Record<string, unknown>,
        context: MCPToolContext,
    ): Promise<MCPToolResult> {
        const def = defs.find((d) => d.tool.name === toolName);
        if (!def) {
            throw new Error(`CSHealLoop: tool not registered: ${toolName}`);
        }
        return def.handler(params, context);
    }
}
